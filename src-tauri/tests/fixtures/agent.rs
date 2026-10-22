//! Deterministic ACP peer. Stdout contains only newline-delimited JSON-RPC.
mod concurrent;
mod content_demo;
mod elicitation;
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, BufRead, Write},
    process::{self, Child, Command},
    thread,
    time::Duration,
};

fn send(output: &mut impl Write, message: Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, &message)?;
    writeln!(output)?;
    output.flush()
}

fn send_session_updates(output: &mut impl Write, key: &str, session: &Value) -> io::Result<()> {
    let Ok(updates) = env::var(key) else {
        return Ok(());
    };
    for update in serde_json::from_str::<Vec<Value>>(&updates)? {
        send(
            output,
            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":update}}),
        )?;
    }
    Ok(())
}

fn auth_status() -> Value {
    if env::var_os("AUTH_FILE").is_some_and(|path| std::path::Path::new(&path).exists()) {
        json!({
            "kind": "account",
            "label": env::var("ACCOUNT_LABEL").unwrap_or_else(|_| "Fixture account".into()),
            "account": {
                "email": env::var("ACCOUNT_EMAIL").ok(),
                "organization": env::var("ACCOUNT_ORGANIZATION").ok(),
                "plan": env::var("ACCOUNT_PLAN").ok(),
            }
        })
    } else {
        json!({"kind": "none", "label": "Not logged in"})
    }
}

fn configuration() -> Value {
    json!([
        {
            "id": "opaque-model",
            "name": "Model",
            "description": "Choose the model",
            "category": "model",
            "type": "select",
            "currentValue": "model-a",
            "options": [
                {"value": "model-a", "name": "Model A"},
                {"value": "model-b", "name": "Model B", "description": "Faster"}
            ]
        },
        {
            "id": "opaque-effort",
            "name": "Effort",
            "category": "thought_level",
            "type": "select",
            "currentValue": "medium",
            "options": [
                {"group": "normal", "name": "Normal", "options": [
                    {"value": "medium", "name": "Medium"},
                    {"value": "high", "name": "High"}
                ]}
            ]
        },
        {
            "id": "opaque-thinking",
            "name": "Thinking",
            "category": "future_category",
            "type": "boolean",
            "currentValue": true
        },
        {
            "id": "opaque-future",
            "name": "Future control",
            "type": "future_control",
            "currentValue": "future"
        }
    ])
}

fn apply_configuration_value(options: &mut Value, config_id: &str, value: &Value) {
    let Some(option) = options
        .as_array_mut()
        .and_then(|options| options.iter_mut().find(|option| option["id"] == config_id))
    else {
        return;
    };
    option["currentValue"] = value.clone();
    if config_id == "opaque-model" && value == "model-b" {
        options[1]["currentValue"] = json!("low");
        options[1]["options"] = json!([{
            "group": "normal",
            "name": "Normal",
            "options": [{"value": "low", "name": "Low"}]
        }]);
    }
}

fn wait_at_configuration_gate(request: usize, stage: &str) -> io::Result<()> {
    let Some(root) = env::var_os("CONFIGURATION_GATE") else {
        return Ok(());
    };
    let root = std::path::PathBuf::from(root);
    fs::create_dir_all(&root)?;
    fs::write(root.join(format!("{request}.{stage}.arrived")), [])?;
    let release = root.join(format!("{request}.{stage}.release"));
    while !release.exists() {
        thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

// Also reap the descendant on normal EOF; the cleanup test kills the process group.
struct Descendant(Child);

impl Drop for Descendant {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().collect();
    if args.iter().any(|arg| arg == "--version") {
        println!("v24.21.0");
        return Ok(());
    }
    if args.iter().any(|arg| arg == "install") {
        let prefix = args
            .iter()
            .position(|arg| arg == "--prefix")
            .ok_or("missing prefix")?;
        let package = std::path::Path::new(&args[prefix + 1]).join("node_modules/@fixture/agent");
        fs::create_dir_all(&package)?;
        fs::write(
            package.join("package.json"),
            r#"{"name":"@fixture/agent","version":"3.2.1","bin":{"agent":"agent.js"}}"#,
        )?;
        fs::write(package.join("agent.js"), "fixture script")?;
        return Ok(());
    }
    if env::args().nth(1).as_deref() == Some("--descendant") {
        thread::sleep(Duration::from_secs(60));
        return Ok(());
    }
    let mode = env::var("FIXTURE_MODE").unwrap_or_else(|_| "ready".into());
    let supports_configuration = env::var_os("CONFIGURATION").is_some();
    let responsive_configuration = env::var_os("RESPONSIVE_CONFIGURATION").is_some();
    let mut current_configuration = configuration();
    if let Some(path) = env::var_os("PID_FILE") {
        fs::write(path, process::id().to_string())?;
    }
    if mode == "concurrent" {
        return concurrent::run();
    }
    let _descendant = if mode == "tree" {
        let mut command = Command::new(env::current_exe()?);
        command.arg("--descendant");
        #[cfg(unix)]
        if env::var_os("DETACHED_CHILD").is_some() {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = Descendant(command.spawn()?);
        fs::write(
            env::var_os("CHILD_PID_FILE").ok_or("missing child PID file")?,
            child.0.id().to_string(),
        )?;
        Some(child)
    } else {
        None
    };
    if env::var("FIXTURE_MODE").is_ok_and(|mode| mode == "elicitation") {
        elicitation::run()?;
        return Ok(());
    }
    let mut input = io::stdin().lock().lines();
    let mut output = io::stdout().lock();
    let mut sessions = 0;
    let mut prompts = 0;
    let mut configuration_requests = 0;
    let mut history: Vec<Value> = env::var_os("SESSION_FILE")
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    while let Some(line) = input.next() {
        let request: Value = serde_json::from_str(&line?)?;
        let method = request["method"].as_str().unwrap_or_default();
        if let Some(path) = env::var_os("REQUEST_LOG") {
            writeln!(
                fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)?,
                "{method}"
            )?;
        }
        let mut error = None;
        let result = match method {
            "initialize" => {
                let capabilities = &request["params"]["clientCapabilities"];
                if matches!(mode.as_str(), "plan-content" | "plan-review-permission") {
                    assert!(capabilities["plan"].is_object());
                }
                assert_ne!(capabilities["terminal"], true);
                if let Some(fs) = capabilities["fs"].as_object() {
                    assert!(!fs.values().any(|value| value == true));
                }
                if supports_configuration {
                    assert!(capabilities["session"]["configOptions"]["boolean"].is_object());
                }
                if mode == "exit-init" {
                    process::exit(12);
                }
                if mode == "init-error" {
                    error = Some(
                        json!({"code": -32603, "message": "initialize rejected", "data": {"source": "fixture"}}),
                    );
                }
                let mut agent_capabilities = if mode == "resume-only" {
                    json!({"sessionCapabilities":{"resume":{}}})
                } else if mode == "no-resume" {
                    json!({})
                } else {
                    json!({"loadSession":true})
                };
                if mode.starts_with("account-") && mode != "account-no-logout" {
                    agent_capabilities["auth"] = json!({"logout": {}});
                }
                if mode.starts_with("account-") && mode != "account-unadvertised-status" {
                    agent_capabilities["_meta"] = json!({"authStatus": {}});
                }
                if let Ok(media) = env::var("MEDIA_CAPABILITIES") {
                    agent_capabilities["promptCapabilities"] = json!({"image": media == "1" || media == "image", "audio": media == "1" || media == "audio"});
                }
                json!({"protocolVersion": if mode == "wrong-version" { 99 } else { 1 }, "agentCapabilities": agent_capabilities, "authMethods": if mode == "future-auth" { json!([{"id":"future-method","name":"Future auth","type":"future_protocol"}]) } else if mode == "key-auth" { json!([{"id": "api-key", "name": "API Key"}]) } else if env::var_os("AUTH_FILE").is_some() { json!([{ "id": "fixture-login", "name": "Fixture login" }, { "id": "fixture-denied", "name": "Denied login" }]) } else { json!([]) }})
            }
            "authenticate" => {
                if request["params"]["methodId"] == "fixture-denied" {
                    send(
                        &mut output,
                        json!({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32603, "message": "login rejected"}}),
                    )?;
                    continue;
                }
                assert_eq!(request["params"]["methodId"], "fixture-login");
                if mode == "slow-auth" {
                    fs::write(
                        env::var_os("AUTH_STARTED_FILE").ok_or("auth started file missing")?,
                        "started",
                    )?;
                    let release =
                        env::var_os("AUTH_RELEASE_FILE").ok_or("auth release file missing")?;
                    while !std::path::Path::new(&release).exists() {
                        thread::sleep(Duration::from_millis(10));
                    }
                }
                fs::write(
                    env::var_os("AUTH_FILE").ok_or("auth file missing")?,
                    "authenticated",
                )?;
                json!({})
            }
            "logout" => {
                if mode == "account-logout-fails" {
                    error = Some(json!({"code": -32603, "message": "logout rejected"}));
                } else if let Some(path) = env::var_os("AUTH_FILE") {
                    fs::remove_file(path)?;
                }
                json!({})
            }
            "session/new" => {
                assert_eq!(
                    request["params"]["cwd"],
                    env::current_dir()?.to_str().ok_or("non-UTF-8 cwd")?
                );
                if mode == "auth" {
                    error = Some(json!({"code": -32000, "message": "Authentication required"}));
                }
                if mode == "session-error" {
                    error = Some(
                        json!({"code": -32603, "message": "session rejected", "data": {"source": "fixture"}}),
                    );
                }
                if mode == "permission" {
                    send(
                        &mut output,
                        json!({"jsonrpc": "2.0", "id": "permission", "method": "session/request_permission",
                        "params": {"sessionId": "remote-1", "toolCall": {"toolCallId": "tool-1"},
                            "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"}]}}),
                    )?;
                    let response: Value =
                        serde_json::from_str(&input.next().ok_or("missing permission response")??)?;
                    assert_eq!(response["result"]["outcome"]["outcome"], "cancelled");
                }
                sessions += 1;
                let mut response = json!({"sessionId": format!("remote-{sessions}")});
                if supports_configuration {
                    response["configOptions"] = configuration();
                }
                response
            }
            "session/resume" => {
                send_session_updates(
                    &mut output,
                    "COMMANDS_UPDATES_RESTORE",
                    &request["params"]["sessionId"],
                )?;
                assert_eq!(mode, "resume-only");
                assert_eq!(request["params"]["sessionId"], "remote-1");
                send_session_updates(
                    &mut output,
                    "TITLE_UPDATES_RESTORE",
                    &request["params"]["sessionId"],
                )?;
                let mut response = json!({});
                if supports_configuration {
                    response["configOptions"] = configuration();
                }
                response
            }
            "session/load" => {
                send_session_updates(
                    &mut output,
                    "COMMANDS_UPDATES_RESTORE",
                    &request["params"]["sessionId"],
                )?;
                send_session_updates(
                    &mut output,
                    "USAGE_UPDATES_RESTORE",
                    &request["params"]["sessionId"],
                )?;
                assert_ne!(mode, "resume-only");
                assert_eq!(request["params"]["sessionId"], "remote-1");
                send_session_updates(
                    &mut output,
                    "TITLE_UPDATES_RESTORE",
                    &request["params"]["sessionId"],
                )?;
                if mode == "replay-chunks" {
                    for (kind, id, text) in [
                        ("user_message_chunk", "a", "Same"),
                        ("user_message_chunk", "a", " question"),
                        ("user_message_chunk", "b", "Same question"),
                        ("agent_message_chunk", "c", "Answer"),
                    ] {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":kind,"messageId":id,"content":{"type":"text","text":text}}}}),
                        )?;
                    }
                }
                for update in &history {
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":update}}),
                    )?;
                }
                if mode == "load-error" {
                    error = Some(json!({"code":-32603,"message":"session missing"}));
                }
                if mode == "load-auth" {
                    error = Some(json!({"code":-32000,"message":"Authentication required"}));
                }
                if mode == "load-exit" {
                    process::exit(16);
                }
                let mut response = json!({});
                if supports_configuration {
                    response["configOptions"] = configuration();
                }
                response
            }
            "session/set_config_option" => {
                assert!(supports_configuration);
                assert_eq!(request["params"]["sessionId"], "remote-1");
                configuration_requests += 1;
                if let Some(path) = env::var_os("CONFIGURATION_REQUEST_LOG") {
                    writeln!(
                        fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(path)?,
                        "{}",
                        serde_json::to_string(&request["params"])?
                    )?;
                }
                wait_at_configuration_gate(configuration_requests, "request")?;
                if env::var_os("CONFIGURATION_UPDATE_WHILE_SET").is_some() {
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"config_option_update","configOptions":current_configuration.clone()}}}),
                    )?;
                    wait_at_configuration_gate(configuration_requests, "update")?;
                }
                if responsive_configuration {
                    let config_id = request["params"]["configId"]
                        .as_str()
                        .ok_or("missing config ID")?;
                    apply_configuration_value(
                        &mut current_configuration,
                        config_id,
                        &request["params"]["value"],
                    );
                    if env::var("CONFIGURATION_FAIL_CONFIG").as_deref() == Ok(config_id) {
                        error = Some(
                            json!({"code": -32603, "message": "configuration rejected", "data": {"source": "fixture"}}),
                        );
                    }
                    json!({"configOptions": current_configuration.clone()})
                } else {
                    assert_eq!(request["params"]["configId"], "opaque-thinking");
                    assert_eq!(request["params"]["type"], "boolean");
                    assert_eq!(request["params"]["value"], false);
                    let mut options = configuration();
                    if env::var_os("CONFIGURATION_UPDATE_OTHER").is_none() {
                        options[2]["currentValue"] = json!(false);
                    }
                    json!({"configOptions": options})
                }
            }
            "session/prompt" => {
                send_session_updates(
                    &mut output,
                    "COMMANDS_UPDATES_RUNNING",
                    &request["params"]["sessionId"],
                )?;
                send_session_updates(
                    &mut output,
                    "USAGE_UPDATES_RUNNING",
                    &request["params"]["sessionId"],
                )?;
                prompts += 1;
                if let Some(path) = env::var_os("PROMPT_METADATA_DB") {
                    let database = rusqlite::Connection::open(path)?;
                    let timestamp: Option<i64> = database.query_row(
                        "SELECT last_prompt_at FROM threads WHERE session_id = ?1",
                        [request["params"]["sessionId"]
                            .as_str()
                            .ok_or("missing session ID")?],
                        |row| row.get(0),
                    )?;
                    writeln!(
                        fs::OpenOptions::new().create(true).append(true).open(
                            env::var_os("PROMPT_METADATA_LOG").ok_or("missing metadata log")?
                        )?,
                        "{}",
                        serde_json::to_string(&timestamp)?
                    )?;
                }
                if let Some(path) = env::var_os("PROMPT_JSON_LOG") {
                    writeln!(
                        fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(path)?,
                        "{}",
                        serde_json::to_string(&request["params"])?
                    )?;
                }
                if let Some(path) = env::var_os("PROMPT_LOG") {
                    writeln!(
                        fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(path)?,
                        "{}",
                        request["params"]["prompt"][0]["text"]
                            .as_str()
                            .unwrap_or_default()
                    )?;
                }
                for content in request["params"]["prompt"].as_array().into_iter().flatten() {
                    history.push(json!({"sessionUpdate":"user_message_chunk","content":content}));
                }
                if mode == "thought-stream" {
                    let updates = [
                        json!({"sessionUpdate":"agent_thought_chunk","messageId":"think-1","content":{"type":"text","text":"**Inspect"}}),
                        json!({"sessionUpdate":"agent_thought_chunk","messageId":"think-1","content":{"type":"text","text":" files**"}}),
                        json!({"sessionUpdate":"plan","entries":[{"content":"Inspect","priority":"high","status":"pending"}]}),
                        json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Plan ready"}}),
                        json!({"sessionUpdate":"tool_call","toolCallId":"read-1","title":"Read file","status":"in_progress"}),
                        json!({"sessionUpdate":"agent_thought_chunk","messageId":"think-2","content":{"type":"text","text":"Read"}}),
                        json!({"sessionUpdate":"tool_call_update","toolCallId":"read-1","status":"completed"}),
                        json!({"sessionUpdate":"plan","entries":[{"content":"Inspect","priority":"high","status":"completed"}]}),
                        json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":" carefully"}}),
                        json!({"sessionUpdate":"agent_thought_chunk","messageId":"think-3","content":{"type":"text","text":"Decide"}}),
                        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Answer"}}),
                        json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Review"}}),
                    ];
                    for update in updates {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":update}}),
                        )?;
                        history.push(update);
                    }
                    if let Some(path) = env::var_os("SESSION_FILE") {
                        fs::write(path, serde_json::to_vec(&history)?)?;
                    }
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),
                    )?;
                    continue;
                }
                if matches!(mode.as_str(), "mixed-content" | "content-demo") {
                    let image = json!({"type":"image","mimeType":"image/png","data":"aW1hZ2U="});
                    let audio = json!({"type":"audio","mimeType":"audio/wav","data":"YXVkaW8="});
                    let resource = json!({"type":"resource","resource":{"uri":"file:///report.txt","mimeType":"text/plain","text":"<h1>literal report</h1>"}});
                    let updates = if mode == "content-demo" {
                        content_demo::updates()?
                    } else {
                        vec![
                            json!({"sessionUpdate":"agent_message_chunk","messageId":"a","content":{"type":"text","text":"Before"}}),
                            json!({"sessionUpdate":"agent_message_chunk","content":image}),
                            json!({"sessionUpdate":"agent_message_chunk","messageId":"b","content":{"type":"text","text":"After image"}}),
                            json!({"sessionUpdate":"agent_message_chunk","content":audio}),
                            json!({"sessionUpdate":"agent_message_chunk","content":resource}),
                            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"resource_link","uri":"https://example.com/report","name":"Report"}}),
                            json!({"sessionUpdate":"tool_call","toolCallId":"mixed-tool","title":"Inspect results","status":"in_progress","content":[
                                {"type":"content","content":{"type":"text","text":"Tool before"}},
                                {"type":"content","content":image},
                                {"type":"content","content":{"type":"text","text":"Tool after"}},
                                {"type":"content","content":resource}
                            ]}),
                            json!({"sessionUpdate":"agent_message_chunk","messageId":"c","content":{"type":"text","text":"End"}}),
                            json!({"sessionUpdate":"agent_message_chunk","messageId":"d","content":{"type":"text","text":"Separate message"}}),
                            json!({"sessionUpdate":"tool_call_update","toolCallId":"mixed-tool","status":"completed"}),
                        ]
                    };
                    for update in updates {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":update}}),
                        )?;
                        history.push(update);
                    }
                    if let Some(path) = env::var_os("SESSION_FILE") {
                        fs::write(path, serde_json::to_vec(&history)?)?;
                    }
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),
                    )?;
                    continue;
                }
                if mode == "tool-stream" {
                    let updates = [
                        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Before"}}),
                        json!({"sessionUpdate":"tool_call","toolCallId":"read-1","title":"Read file","kind":"read","status":"pending","rawInput":{"path":"fixture.txt"}}),
                        json!({"sessionUpdate":"tool_call_update","toolCallId":"execute-1","title":"Run tests","kind":"execute","status":"in_progress"}),
                        json!({"sessionUpdate":"tool_call_update","toolCallId":"read-1","status":"in_progress"}),
                        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"After"}}),
                        json!({"sessionUpdate":"tool_call_update","toolCallId":"execute-1","status":"failed","rawOutput":"Test failure"}),
                        json!({"sessionUpdate":"tool_call_update","toolCallId":"read-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"File contents"}}],"locations":[{"path":"/fixture.txt","line":2}]}),
                    ];
                    for update in updates {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":update}}),
                        )?;
                        history.push(update);
                    }
                    if let Some(path) = env::var_os("SESSION_FILE") {
                        fs::write(path, serde_json::to_vec(&history)?)?;
                    }
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),
                    )?;
                    continue;
                }
                if mode == "plan-content" {
                    let updates = if prompts == 1 {
                        vec![
                            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Before"}}),
                            json!({"sessionUpdate":"plan_update","plan":{"type":"markdown","planId":"document","content":"# Initial"}}),
                            json!({"sessionUpdate":"plan_update","plan":{"type":"items","planId":"steps","entries":[{"content":"Inspect","priority":"high","status":"completed"}]}}),
                            json!({"sessionUpdate":"plan_update","plan":{"type":"file","planId":"file","uri":"file:///tmp/plan.md"}}),
                            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"After"}}),
                            json!({"sessionUpdate":"plan_removed","planId":"document"}),
                            json!({"sessionUpdate":"plan_removed","planId":"unknown"}),
                            json!({"sessionUpdate":"plan_update","plan":{"type":"markdown","planId":"document","content":"# Restored"}}),
                        ]
                    } else {
                        vec![
                            json!({"sessionUpdate":"plan_update","plan":{"type":"markdown","planId":"document","content":"# Updated in next turn"}}),
                            json!({"sessionUpdate":"plan_removed","planId":"file"}),
                        ]
                    };
                    for update in updates {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":update}}),
                        )?;
                        history.push(update);
                    }
                    if let Some(path) = env::var_os("SESSION_FILE") {
                        fs::write(path, serde_json::to_vec(&history)?)?;
                    }
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),
                    )?;
                    continue;
                }
                if mode == "plan-stream" {
                    let updates = [
                        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Before"}}),
                        json!({"sessionUpdate":"plan","entries":[{"content":"Read","priority":"high","status":"pending"},{"content":"Test","priority":"low","status":"pending"}]}),
                        json!({"sessionUpdate":"tool_call","toolCallId":"read-1","title":"Read file","status":"completed"}),
                        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"After"}}),
                        json!({"sessionUpdate":"plan","entries":[]}),
                        json!({"sessionUpdate":"plan","entries":[{"content":"Test","priority":"low","status":"completed"},{"content":"Review","priority":"high","status":"in_progress"}]}),
                    ];
                    for update in updates {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":update}}),
                        )?;
                        history.push(update);
                    }
                    if let Some(path) = env::var_os("SESSION_FILE") {
                        fs::write(path, serde_json::to_vec(&history)?)?;
                    }
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),
                    )?;
                    continue;
                }
                history.push(json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello world"}}));
                if let Some(path) = env::var_os("SESSION_FILE") {
                    fs::write(path, serde_json::to_vec(&history)?)?;
                }
                if mode == "empty-response" {
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),
                    )?;
                    continue;
                }
                assert_eq!(request["params"]["sessionId"], "remote-1");
                if prompts == 1 {
                    send_session_updates(
                        &mut output,
                        "TITLE_UPDATES_RUNNING",
                        &request["params"]["sessionId"],
                    )?;
                    send_session_updates(&mut output, "TITLE_UPDATES_FOREIGN", &json!("foreign"))?;
                }
                if env::var_os("CONFIGURATION_UPDATE_DURING_PROMPT").is_some() {
                    let mut foreign = configuration();
                    foreign[2]["currentValue"] = json!(true);
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"foreign","update":{"sessionUpdate":"config_option_update","configOptions":foreign}}}),
                    )?;
                    let mut current = configuration();
                    current[2]["currentValue"] = json!(false);
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"config_option_update","configOptions":current}}}),
                    )?;
                }
                if matches!(mode.as_str(), "cancel" | "cancel-race") && prompts == 1 {
                    if env::var_os("CANCEL_TOOL").is_some() {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"tool_call","toolCallId":"cancel-tool","title":"Run command","kind":"execute","status":"in_progress"}}}),
                        )?;
                    }

                    if env::var_os("CANCEL_THOUGHT").is_some() {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Before cancellation"}}}}),
                        )?;
                    }
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Started"}}}}),
                    )?;
                    let cancel: Value =
                        serde_json::from_str(&input.next().ok_or("missing cancel")??)?;
                    assert_eq!(cancel["method"], "session/cancel");
                    assert_eq!(cancel["params"]["sessionId"], "remote-1");
                    if env::var_os("CANCEL_THOUGHT").is_some() {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Late thought"}}}}),
                        )?;
                    }
                    if env::var_os("CANCEL_TOOL").is_some() {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"tool_call_update","toolCallId":"cancel-tool","status":"failed","rawOutput":"Command stopped"}}}),
                        )?;
                    }

                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"late cancelled output"}}}}),
                    )?;
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason": if mode == "cancel-race" { "end_turn" } else { "cancelled" }}}),
                    )?;
                    continue;
                }
                send(
                    &mut output,
                    json!({"jsonrpc": "2.0", "method": "session/update", "params": {
                        "sessionId": "foreign", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "wrong session"}}
                    }}),
                )?;
                if mode == "plan-review-permission" {
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"plan_update","plan":{"type":"markdown","planId":"document","content":"# Greeting CLI\n- Add the command"}}}}),
                    )?;
                }
                if matches!(
                    mode.as_str(),
                    "prompt-permission" | "partial-permission" | "plan-review-permission"
                ) || (mode == "permission-cancel" && prompts == 1)
                {
                    if mode == "partial-permission" {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Initial title", "rawInput":{"path":"old.txt"}}}}),
                        )?;
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","title":"Write fixture.txt", "rawInput":{"path":"fixture.txt"}}}}),
                        )?;
                    }
                    send(
                        &mut output,
                        json!({"jsonrpc": "2.0", "id": "permission", "method": "session/request_permission", "params": {
                            "sessionId": "remote-1",
                            "toolCall": if mode == "plan-review-permission" {
                                json!({"toolCallId":"plan-review:document","title":"Implement this plan?","kind":"switch_mode","rawInput":{"plan":"# Greeting CLI\n- Add the command"}})
                            } else if mode == "partial-permission" {
                                json!({"toolCallId":"tool-1"})
                            } else {
                                json!({"toolCallId":"tool-1","title":"Write fixture.txt","rawInput":{"path":"fixture.txt"}})
                            },
                            "options": if mode == "plan-review-permission" {
                                json!([{"optionId":"implement_plan","name":"Implement","kind":"allow_once"},{"optionId":"revise_plan","name":"Revise","kind":"reject_once"}])
                            } else {
                                json!([{"optionId":"deny-927","name":"Do not write","kind":"reject_once"},{"optionId":"arbitrary-allow","name":"Write once","kind":"allow_once"}])
                            }
                        }}),
                    )?;
                    if mode == "permission-cancel" {
                        let mut cancelled = false;
                        let mut resolved = false;
                        while !cancelled || !resolved {
                            let response: Value = serde_json::from_str(
                                &input.next().ok_or("missing cancellation")??,
                            )?;
                            if response["method"] == "session/cancel" {
                                assert_eq!(response["params"]["sessionId"], "remote-1");
                                cancelled = true;
                            } else {
                                assert_eq!(response["result"]["outcome"]["outcome"], "cancelled");
                                resolved = true;
                            }
                        }
                        // A request already in flight at cancellation must never execute.
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","id":"late-permission","method":"session/request_permission","params":{"sessionId":"remote-1","toolCall":{"toolCallId":"late-tool"},"options":[{"optionId":"late-allow","name":"Late allow","kind":"allow_once"}]}}),
                        )?;
                        let response: Value = serde_json::from_str(
                            &input.next().ok_or("missing late cancellation")??,
                        )?;
                        assert_eq!(response["result"]["outcome"]["outcome"], "cancelled");
                        if let Some(path) = env::var_os("CANCELLATION_FILE") {
                            fs::write(path, "turn and permissions cancelled")?;
                        }
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"cancelled"}}),
                        )?;
                        continue;
                    }
                    let response: Value =
                        serde_json::from_str(&input.next().ok_or("missing permission response")??)?;
                    assert_eq!(response["result"]["outcome"]["outcome"], "selected");
                    let selected = response["result"]["outcome"]["optionId"]
                        .as_str()
                        .ok_or("missing option")?;
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("selected:{selected}")}}}}),
                    )?;
                }
                for text in ["Hello", " world"] {
                    send(
                        &mut output,
                        json!({"jsonrpc": "2.0", "method": "session/update", "params": {
                            "sessionId": "remote-1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}
                        }}),
                    )?;
                    if text == "Hello" {
                        if let Some(root) = env::var_os("PROMPT_GATE_DIR") {
                            let root = std::path::PathBuf::from(root);
                            fs::create_dir_all(&root)?;
                            fs::write(root.join(format!("{prompts}.arrived")), [])?;
                            let release = root.join(format!("{prompts}.release"));
                            let started = std::time::Instant::now();
                            while !release.exists() {
                                if started.elapsed() > Duration::from_secs(5) {
                                    return Err("prompt gate timed out".into());
                                }
                                thread::sleep(Duration::from_millis(5));
                            }
                        }
                        if let Some(path) = env::var_os("PROMPT_GATE") {
                            let started = std::time::Instant::now();
                            while !std::path::Path::new(&path).exists() {
                                if started.elapsed() > Duration::from_secs(5) {
                                    return Err("prompt gate timed out".into());
                                }
                                thread::sleep(Duration::from_millis(5));
                            }
                        }
                    }
                }
                if mode == "prompt-exit" {
                    process::exit(14);
                }
                if mode == "prompt-auth" || mode == "prompt-auth-exit" {
                    error = Some(json!({"code": -32000, "message": "Authentication required"}));
                }
                if mode == "prompt-error" || (mode == "queued-prompt-error-once" && prompts == 2) {
                    error = Some(
                        json!({"code": -32603, "message": "Prompt failed", "data": {"source": "fixture"}}),
                    );
                }
                json!({"stopReason": if matches!(mode.as_str(), "refusal" | "max_tokens" | "max_turn_requests") { mode.as_str() } else { "end_turn" }})
            }
            _ => continue,
        };
        if matches!(
            method,
            "session/new"
                | "session/prompt"
                | "session/load"
                | "session/resume"
                | "session/set_config_option"
        ) && env::var_os("AUTH_FILE").is_some_and(|path| !std::path::Path::new(&path).exists())
        {
            error = Some(json!({"code": -32000, "message": "Authentication required"}));
        }
        let mut response = json!({"jsonrpc": "2.0", "id": request["id"]});
        if let Some(error) = error {
            response["error"] = error;
        } else {
            response["result"] = result;
        }
        let new_session = response["result"]["sessionId"].clone();
        send(&mut output, response)?;
        if method == "session/new" {
            if let Some(gate) = env::var_os("TITLE_UPDATES_NEW_GATE") {
                while !std::path::Path::new(&gate).exists() {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            send_session_updates(&mut output, "TITLE_UPDATES_NEW", &new_session)?;
            send_session_updates(&mut output, "COMMANDS_UPDATES_NEW", &new_session)?;
        }
        if method == "session/prompt" && prompts == 1 {
            send_session_updates(
                &mut output,
                "TITLE_UPDATES_IDLE",
                &request["params"]["sessionId"],
            )?;
        }
        if (method == "initialize"
            || method == "authenticate"
            || method == "logout"
            || method == "session/prompt")
            && mode.starts_with("account-")
        {
            send(
                &mut output,
                json!({"jsonrpc": "2.0", "method": "_auth/status_update", "params": {"authStatus": auth_status()}}),
            )?;
        }
        if method == "session/set_config_option"
            && env::var_os("CONFIGURATION_UPDATE_AFTER_SET").is_some()
        {
            let mut foreign = configuration();
            foreign[2]["currentValue"] = json!(false);
            send(
                &mut output,
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"foreign","update":{"sessionUpdate":"config_option_update","configOptions":foreign}}}),
            )?;
            send(
                &mut output,
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-1","update":{"sessionUpdate":"config_option_update","configOptions":configuration()}}}),
            )?;
        }
        if method == "session/set_config_option"
            && env::var_os("CONFIGURATION_UPDATE_OTHER").is_some()
        {
            let mut other = configuration();
            other[2]["currentValue"] = json!(false);
            send(
                &mut output,
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote-2","update":{"sessionUpdate":"config_option_update","configOptions":other}}}),
            )?;
        }
        if method == "session/prompt" && mode == "prompt-auth-exit" {
            process::exit(15);
        }
        // Inject stale output after failure. Successful v1 turns end at the prompt
        // response; their next prompt must not be preceded by untagged old text.
        if method == "session/prompt" && matches!(mode.as_str(), "prompt-auth" | "prompt-error") {
            send(
                &mut output,
                json!({"jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": "remote-1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "stale output"}}
                }}),
            )?;
        }
        if method == "session/new" && mode == "exit-ready" {
            thread::sleep(Duration::from_millis(200));
            process::exit(13);
        }
    }
    if let Some(gate) = env::var_os("EOF_GATE") {
        let gate = std::path::PathBuf::from(gate);
        fs::write(gate.with_extension("arrived"), "waiting")?;
        while !gate.exists() {
            thread::sleep(Duration::from_millis(5));
        }
    }
    if env::var_os("DETACHED_CHILD").is_some() {
        thread::sleep(Duration::from_secs(60));
    }
    Ok(())
}
