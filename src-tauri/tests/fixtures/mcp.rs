//! Minimal real MCP peer and agent-side forwarding used by the ACP fixture.
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, BufRead, Write},
    process::{Command, Stdio},
};

pub fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let mut output = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        if request.get("id").is_none() {
            continue;
        }
        let result = match request["method"].as_str().unwrap_or_default() {
            "initialize" => {
                json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
            }
            "tools/list" => {
                json!({"tools":[{"name":"where","description":"Return the working directory","inputSchema":{"type":"object"}}]})
            }
            "tools/call" => {
                assert_eq!(env::var("API_KEY")?, "fixture-key");
                json!({"content":[{"type":"text","text":format!("MCP tool result: {}", env::current_dir()?.display())}]})
            }
            _ => return Err("Unexpected MCP method".into()),
        };
        serde_json::to_writer(
            &mut output,
            &json!({"jsonrpc":"2.0","id":request["id"],"result":result}),
        )?;
        writeln!(output)?;
        output.flush()?;
    }
    Ok(())
}

pub fn record(method: &str, params: &Value) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(path) = env::var_os("MCP_LOG") {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        let names = params["mcpServers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|server| server["name"].as_str())
            .collect::<Vec<_>>()
            .join(",");
        writeln!(file, "{method}:{names}")?;
    }
    Ok(())
}

pub fn call(servers: &Value, cwd: &Value) -> Result<String, Box<dyn std::error::Error>> {
    let server = servers
        .as_array()
        .and_then(|servers| servers.iter().find(|server| server["name"] == "tool"))
        .ok_or("Missing forwarded server")?;
    let mut command = Command::new(server["command"].as_str().ok_or("Missing MCP command")?);
    for arg in server["args"].as_array().into_iter().flatten() {
        command.arg(arg.as_str().ok_or("Invalid MCP argument")?);
    }
    for value in server["env"].as_array().into_iter().flatten() {
        command.env(
            value["name"].as_str().ok_or("Missing variable name")?,
            value["value"].as_str().ok_or("Missing variable value")?,
        );
    }
    let mut child = command
        .current_dir(cwd.as_str().ok_or("Missing cwd")?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let result = (|| {
        let mut input = child.stdin.take().ok_or("Missing MCP stdin")?;
        let mut output = io::BufReader::new(child.stdout.take().ok_or("Missing MCP stdout")?);
        let mut last = json!(null);
        for (id, method) in [(1, "initialize"), (2, "tools/list"), (3, "tools/call")] {
            let params = if method == "initialize" {
                json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"fixture-agent","version":"1"}})
            } else if method == "tools/call" {
                json!({"name":"where","arguments":{}})
            } else {
                json!({})
            };
            writeln!(
                input,
                "{}",
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
            )?;
            input.flush()?;
            let mut line = String::new();
            output.read_line(&mut line)?;
            last = serde_json::from_str::<Value>(&line)?;
            assert_eq!(last["id"], id);
            if method == "initialize" {
                writeln!(
                    input,
                    "{}",
                    json!({"jsonrpc":"2.0","method":"notifications/initialized"})
                )?;
                input.flush()?;
            }
            if method == "tools/list" {
                assert_eq!(last["result"]["tools"][0]["name"], "where");
            }
        }
        Ok::<_, Box<dyn std::error::Error>>(
            last["result"]["content"][0]["text"]
                .as_str()
                .ok_or("Missing tool result")?
                .to_string(),
        )
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}
