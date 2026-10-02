use super::*;
use std::collections::HashMap;

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut output = io::stdout().lock();
    let mut sessions = 0;
    let mut active = HashMap::<String, Value>::new();
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let method = request["method"].as_str().unwrap_or_default();
        let session = request["params"]["sessionId"].as_str().unwrap_or_default();
        if let Some(path) = env::var_os("REQUEST_LOG") {
            writeln!(
                fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)?,
                "{method} {session}"
            )?;
        }
        let result = match method {
            "initialize" => {
                let connection_mode = env::var("DELETE_CONNECTION_MODE").unwrap_or_default();
                if connection_mode == "exit" {
                    process::exit(18);
                }
                if connection_mode == "init-error" {
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32603,"message":"initialize rejected with private fixture details"}}),
                    )?;
                    continue;
                }
                let session_capabilities = env::var_os("DELETE_MODE")
                    .is_some()
                    .then(|| json!({"delete":{}}));
                json!({"protocolVersion":1,"agentCapabilities":{"loadSession":true,"sessionCapabilities":session_capabilities.unwrap_or_default()},"authMethods":[]})
            }
            "session/new" => {
                sessions += 1;
                json!({"sessionId":format!("remote-{sessions}")})
            }
            "session/load" => json!({}),
            "session/prompt" => {
                let text = request["params"]["prompt"][0]["text"].as_str().unwrap();
                if text == "exit" {
                    process::exit(14);
                }
                if !matches!(text, "no-text-hold" | "no-text-approval") {
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("reply:{text}")}}}}),
                    )?;
                }
                if matches!(
                    text,
                    "hold" | "approval" | "no-text-hold" | "no-text-approval"
                ) {
                    active.insert(session.into(), request["id"].clone());
                    if matches!(text, "approval" | "no-text-approval") {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","id":format!("permission:{session}"),"method":"session/request_permission","params":{"sessionId":session,"toolCall":{"toolCallId":"write","title":"Write fixture"},"options":[{"optionId":"allow","name":"Allow once","kind":"allow_once"}]}}),
                        )?;
                    }
                    continue;
                }
                json!({"stopReason":"end_turn"})
            }
            "session/cancel" => {
                if let Some(id) = active.remove(session) {
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","id":id,"result":{"stopReason":"cancelled"}}),
                    )?;
                }
                continue;
            }
            "session/delete" => {
                let mode = env::var("DELETE_MODE").unwrap_or_default();
                if mode == "delayed" {
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"late deleted output"}}}}),
                    )?;
                    continue;
                }
                if mode == "error" {
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32603,"message":"delete rejected with private fixture details"}}),
                    )?;
                    continue;
                }
                if mode == "auth" {
                    send(
                        &mut output,
                        json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"authentication required with private fixture details"}}),
                    )?;
                    continue;
                }
                if mode == "close" {
                    process::exit(17);
                }
                json!({})
            }
            "" => {
                if request["result"]["outcome"]["outcome"] == "selected" {
                    let session = request["id"]
                        .as_str()
                        .unwrap()
                        .strip_prefix("permission:")
                        .unwrap();
                    if let Some(id) = active.remove(session) {
                        send(
                            &mut output,
                            json!({"jsonrpc":"2.0","id":id,"result":{"stopReason":"end_turn"}}),
                        )?;
                    }
                }
                continue;
            }
            _ => continue,
        };
        send(
            &mut output,
            json!({"jsonrpc":"2.0","id":request["id"],"result":result}),
        )?;
    }
    Ok(())
}
