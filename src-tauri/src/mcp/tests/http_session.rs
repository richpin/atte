use super::*;
use std::{
    io::{BufRead, Read, Write},
    net::{TcpListener, TcpStream},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    thread::{self, JoinHandle},
    time::Duration,
};

pub(super) struct HttpFixture {
    pub(super) url: String,
    calls: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    task: Option<JoinHandle<()>>,
    pub(super) deletions: Arc<AtomicUsize>,
}
impl HttpFixture {
    pub(super) fn start() -> Self {
        Self::with_session(false)
    }
    pub(super) fn with_session(stateful: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let count = calls.clone();
        let stopping = stop.clone();
        let deletions = Arc::new(AtomicUsize::new(0));
        let deleted = deletions.clone();
        let task = thread::spawn(move || {
            while !stopping.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => handle(stream, &count, stateful, &deleted).unwrap(),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("HTTP fixture accept failed: {error}"),
                }
            }
        });
        Self {
            url,
            calls,
            stop,
            task: Some(task),
            deletions,
        }
    }
}
impl Drop for HttpFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}
fn handle(
    mut stream: TcpStream,
    calls: &AtomicUsize,
    stateful: bool,
    deletions: &AtomicUsize,
) -> Result<(), Box<dyn std::error::Error>> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = std::io::BufReader::new(stream.try_clone()?);
    let mut headers = BTreeMap::new();
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let method = line
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string();
    loop {
        line.clear();
        reader.read_line(&mut line)?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.trim().split_once(':') {
            headers.insert(key.to_ascii_lowercase(), value.trim().to_string());
        }
    }
    if method == "GET" || method == "DELETE" {
        if method == "DELETE" {
            deletions.fetch_add(1, Ordering::AcqRel);
        }
        let status = if method == "DELETE" {
            "204 No Content"
        } else {
            "405 Method Not Allowed"
        };
        write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )?;
        stream.flush()?;
        return Ok(());
    }
    let length = headers
        .get("content-length")
        .ok_or("Missing body length")?
        .parse::<usize>()?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let request: Value = serde_json::from_slice(&body)?;
    let authorized = headers
        .get("authorization")
        .is_some_and(|value| value == "Bearer http-fixture-key")
        && headers
            .get("x-api-key")
            .is_some_and(|value| value == "custom-fixture-key");
    if authorized && request["method"] == "notifications/initialized" {
        write!(
            stream,
            "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )?;
        stream.flush()?;
        return Ok(());
    }
    let (status, result) = if !authorized {
        (
            "401 Unauthorized",
            json!({"error":"Authentication required"}),
        )
    } else {
        let result = match request["method"].as_str().unwrap_or_default() {
            "initialize" => {
                json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"http-fixture","version":"1"}})
            }
            "notifications/initialized" => json!(null),
            "tools/list" => json!({"tools":[{"name":"where","inputSchema":{"type":"object"}}]}),
            "tools/call" => {
                calls.fetch_add(1, Ordering::AcqRel);
                json!({"content":[{"type":"text","text":"MCP HTTP tool result"}]})
            }
            _ => return Err("Unexpected HTTP MCP method".into()),
        };
        (
            "200 OK",
            json!({"jsonrpc":"2.0","id":request["id"],"result":result}),
        )
    };
    let body = result.to_string();
    let session = if stateful && authorized && request["method"] == "initialize" {
        "Mcp-Session-Id: fixture-session\r\n"
    } else {
        ""
    };
    write!(stream, "HTTP/1.1 {status}\r\n{session}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())?;
    stream.flush()?;
    Ok(())
}

#[tokio::test]
#[ignore = "Binds a loopback MCP fixture; requires local network access"]
async fn supported_http_servers_forward_authentication_and_call_tools_on_new_load_and_resume() {
    for mode in ["normal", "resume-only"] {
        let remote = HttpFixture::start();
        let root = tempfile::tempdir().unwrap();
        let service = Arc::new(service(root.path(), Arc::new(MemoryCredentials::default())));
        let server: Server = serde_json::from_value(json!({"type":"http","url":remote.url,"headers":{"Authorization":{"kind":"secret","value":""},"X-Api-Key":{"kind":"environment","value":"HTTP_FIXTURE_KEY"}}})).unwrap();
        service
            .save(
                &Target::Global,
                "tool",
                server,
                BTreeMap::from([("Authorization".into(), "Bearer http-fixture-key".into())]),
                true,
            )
            .unwrap();
        let log = root.path().join("requests.log");
        let agent = crate::agent::AgentDefinition {
            id: "fixture".into(),
            name: "Fixture".into(),
            launch_kind: Default::default(),
            command: fixture(),
            args: vec![],
            env: std::collections::HashMap::from([
                ("FIXTURE_MODE".into(), mode.into()),
                ("MCP_HTTP".into(), "1".into()),
                ("MCP_LOG".into(), log.to_string_lossy().into()),
                ("HTTP_FIXTURE_KEY".into(), "custom-fixture-key".into()),
            ]),
            node_runtime: None,
        };
        let threads = crate::thread::Threads::new(vec![agent]);
        threads.set_mcp(service);
        let draft = threads.create(root.path()).unwrap();
        threads.connect(draft.id).unwrap();
        let connected = ready(&threads, draft.id).await;
        assert!(
            connected.mcp.issues.is_empty(),
            "{:?}",
            connected.mcp.issues
        );
        threads
            .send_message(draft.id, "Call HTTP tool".into())
            .unwrap();
        let called = ready(&threads, draft.id).await;
        assert_eq!(called.status, crate::thread::ThreadStatus::SessionReady);
        assert!(serde_json::to_string(&called.turns.last())
            .unwrap()
            .contains("MCP HTTP tool result"));
        threads.reconnect(draft.id).unwrap();
        ready(&threads, draft.id).await;
        threads
            .send_message(draft.id, "Call HTTP tool after restoration".into())
            .unwrap();
        let called = ready(&threads, draft.id).await;
        assert_eq!(called.status, crate::thread::ThreadStatus::SessionReady);
        assert_eq!(remote.calls.load(Ordering::Acquire), 2);
        let methods = std::fs::read_to_string(log).unwrap();
        assert!(methods.contains(if mode == "resume-only" {
            "session/resume:tool"
        } else {
            "session/load:tool"
        }));
        assert!(!serde_json::to_string(&called)
            .unwrap()
            .contains("http-fixture-key"));
        threads.shutdown().await;
    }
}
