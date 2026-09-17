//! Deterministic ACP peer. Stdout contains only newline-delimited JSON-RPC.
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

// Also reap the descendant on normal EOF; the cleanup test kills the process group.
struct Descendant(Child);

impl Drop for Descendant {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::args().nth(1).as_deref() == Some("--descendant") {
        thread::sleep(Duration::from_secs(60));
        return Ok(());
    }
    let mode = env::var("FIXTURE_MODE").unwrap_or_else(|_| "ready".into());
    if let Some(path) = env::var_os("PID_FILE") {
        fs::write(path, process::id().to_string())?;
    }
    let _descendant = if mode == "tree" {
        let child = Descendant(
            Command::new(env::current_exe()?)
                .arg("--descendant")
                .spawn()?,
        );
        fs::write(
            env::var_os("CHILD_PID_FILE").ok_or("missing child PID file")?,
            child.0.id().to_string(),
        )?;
        Some(child)
    } else {
        None
    };
    let mut input = io::stdin().lock().lines();
    let mut output = io::stdout().lock();
    let mut sessions = 0;
    while let Some(line) = input.next() {
        let request: Value = serde_json::from_str(&line?)?;
        let method = request["method"].as_str().unwrap_or_default();
        let mut error = None;
        let result = match method {
            "initialize" => {
                let capabilities = &request["params"]["clientCapabilities"];
                assert_ne!(capabilities["terminal"], true);
                if let Some(fs) = capabilities["fs"].as_object() {
                    assert!(!fs.values().any(|value| value == true));
                }
                if mode == "exit-init" {
                    process::exit(12);
                }
                if mode == "init-error" {
                    error = Some(json!({"code": -32603, "message": "initialize rejected"}));
                }
                json!({"protocolVersion": if mode == "wrong-version" { 99 } else { 1 }, "agentCapabilities": {}, "authMethods": if mode == "key-auth" { json!([{"id": "api-key", "name": "API Key"}]) } else if env::var_os("AUTH_FILE").is_some() { json!([{ "id": "fixture-login", "name": "Fixture login" }, { "id": "fixture-denied", "name": "Denied login" }]) } else { json!([]) }})
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
                fs::write(
                    env::var_os("AUTH_FILE").ok_or("auth file missing")?,
                    "authenticated",
                )?;
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
                    error = Some(json!({"code": -32603, "message": "session rejected"}));
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
                json!({"sessionId": format!("remote-{sessions}")})
            }
            "session/prompt" => {
                assert_eq!(request["params"]["sessionId"], "remote-1");
                send(
                    &mut output,
                    json!({"jsonrpc": "2.0", "method": "session/update", "params": {
                        "sessionId": "foreign", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "wrong session"}}
                    }}),
                )?;
                if mode == "prompt-permission" {
                    send(
                        &mut output,
                        json!({"jsonrpc": "2.0", "id": "permission", "method": "session/request_permission", "params": {
                            "sessionId": "remote-1", "toolCall": {"toolCallId": "tool-1"}, "options": [{"optionId": "arbitrary-allow", "name": "Allow", "kind": "allow_once"}]
                        }}),
                    )?;
                    let response: Value =
                        serde_json::from_str(&input.next().ok_or("missing permission response")??)?;
                    assert_eq!(response["result"]["outcome"]["outcome"], "cancelled");
                }
                for text in ["Hello", " world"] {
                    send(
                        &mut output,
                        json!({"jsonrpc": "2.0", "method": "session/update", "params": {
                            "sessionId": "remote-1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}
                        }}),
                    )?;
                    if text == "Hello" {
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
                if mode == "prompt-error" {
                    error = Some(json!({"code": -32603, "message": "Prompt failed"}));
                }
                json!({"stopReason": "end_turn"})
            }
            _ => continue,
        };
        if matches!(method, "session/new" | "session/prompt")
            && env::var_os("AUTH_FILE").is_some_and(|path| !std::path::Path::new(&path).exists())
        {
            error = Some(json!({"code": -32000, "message": "Authentication required"}));
        }
        let mut response = json!({"jsonrpc": "2.0", "id": request["id"]});
        if let Some(error) = error {
            response["error"] = error;
        } else {
            response["result"] = result;
        }
        send(&mut output, response)?;
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
    Ok(())
}
