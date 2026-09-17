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
                json!({"protocolVersion": if mode == "wrong-version" { 99 } else { 1 }, "agentCapabilities": {}, "authMethods": []})
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
            _ => continue,
        };
        let mut response = json!({"jsonrpc": "2.0", "id": request["id"]});
        if let Some(error) = error {
            response["error"] = error;
        } else {
            response["result"] = result;
        }
        send(&mut output, response)?;
        if method == "session/new" && mode == "exit-ready" {
            thread::sleep(Duration::from_millis(200));
            process::exit(13);
        }
    }
    Ok(())
}
