//! Stateful ACP peer for concurrent forms, approvals and setup requests.
use super::{configuration, send};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    env,
    fs::OpenOptions,
    io::{self, BufRead, Write},
};

struct Operation {
    response: Value,
    waiting: HashSet<u64>,
}

pub(super) fn run() -> io::Result<()> {
    let mut output = io::stdout().lock();
    let mut operations = HashMap::<String, Operation>::new();
    let mut requests = HashMap::<u64, String>::new();
    let mut next = 1000u64;
    let mut sessions = 0;
    let phase = env::var("ELICITATION_PHASE").unwrap_or_else(|_| "session/prompt".into());
    for line in io::stdin().lock().lines() {
        let message: Value = serde_json::from_str(&line?)?;
        if let Some(path) = env::var_os("ELICITATION_LOG") {
            writeln!(
                OpenOptions::new().create(true).append(true).open(path)?,
                "{message}"
            )?;
        }
        let method = message["method"].as_str().unwrap_or_default();
        if method.is_empty() {
            if let Some(id) = message["id"].as_u64() {
                if let Some(key) = requests.remove(&id) {
                    if let Some(operation) = operations.get_mut(&key) {
                        operation.waiting.remove(&id);
                        if operation.waiting.is_empty() {
                            let operation = operations.remove(&key).unwrap();
                            send(&mut output, operation.response)?;
                        }
                    }
                }
            }
            continue;
        }
        if method == "session/cancel" {
            for operation in operations.values_mut() {
                if operation.response["result"].get("stopReason").is_some() {
                    operation.response["result"]["stopReason"] = json!("cancelled");
                }
            }
            continue;
        }
        let result = match method {
            "initialize" => {
                json!({"protocolVersion":1,"agentCapabilities":{"loadSession": env::var_os("ELICITATION_RESUME_ONLY").is_none(),"sessionCapabilities":{"resume":{},"delete":{}}}})
            }
            "session/new" => {
                sessions += 1;
                json!({"sessionId":format!("session-{sessions}"),"configOptions":configuration()})
            }
            "session/load" | "session/resume" | "session/set_config_option" => {
                json!({"configOptions":configuration()})
            }
            "session/prompt" => json!({"stopReason":"end_turn"}),
            _ => json!({}),
        };
        let response = json!({"jsonrpc":"2.0","id":message["id"],"result":result});
        if method != phase {
            send(&mut output, response)?;
            continue;
        }
        let key = message["id"].to_string();
        let mut operation = Operation {
            response,
            waiting: HashSet::new(),
        };
        if env::var_os("ELICITATION_MIXED").is_some() && method == "session/prompt" {
            next += 1;
            send(
                &mut output,
                json!({"jsonrpc":"2.0","id":next,"method":"session/request_permission","params":{"sessionId":message["params"]["sessionId"],"toolCall":{"toolCallId":"approval","title":"Approve","kind":"read"},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"}]}}),
            )?;
            operation.waiting.insert(next);
            requests.insert(next, key.clone());
        }
        let schemas: Vec<Value> = env::var("ELICITATION_SCHEMAS").ok().map(|value| serde_json::from_str(&value)).transpose()?.unwrap_or_else(|| vec![json!({"type":"object","properties":{"strategy":{"type":"string","enum":["safe","fast"],"default":"safe"}},"required":["strategy"]})]);
        for schema in schemas {
            next += 1;
            let mut params =
                json!({"mode":"form","message":"Choose an approach","requestedSchema":schema});
            if method == "session/prompt" && env::var_os("ELICITATION_REQUEST_SCOPE").is_none() {
                params["sessionId"] = message["params"]["sessionId"].clone();
            } else {
                params["requestId"] = message["id"].clone();
            }
            if env::var_os("ELICITATION_UNKNOWN_OWNER").is_some() {
                params["requestId"] = json!("unrelated");
                params.as_object_mut().unwrap().remove("sessionId");
            }
            if env::var_os("ELICITATION_URL").is_some() {
                params["mode"] = json!("url");
                params["url"] = json!("https://example.com");
                params["elicitationId"] = json!("url-1");
            }
            send(
                &mut output,
                json!({"jsonrpc":"2.0","id":next,"method":"elicitation/create","params":params}),
            )?;
            operation.waiting.insert(next);
            requests.insert(next, key.clone());
            if env::var_os("ELICITATION_CANCEL_REQUEST").is_some() {
                send(
                    &mut output,
                    json!({"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":next}}),
                )?;
            }
            if env::var_os("ELICITATION_EXIT").is_some() {
                return Ok(());
            }
        }
        operations.insert(key, operation);
    }
    Ok(())
}
