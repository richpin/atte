use super::*;
use std::collections::HashMap;

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut output = io::stdout().lock();
    let mut sessions = 0;
    let mut active = HashMap::<String, Value>::new();
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let session = request["params"]["sessionId"].as_str().unwrap_or_default();
        let result = match request["method"].as_str().unwrap_or_default() {
            "initialize" => {
                json!({"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[]})
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
                send(
                    &mut output,
                    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("reply:{text}")}}}}),
                )?;
                if text == "hold" || text == "approval" {
                    active.insert(session.into(), request["id"].clone());
                    if text == "approval" {
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
