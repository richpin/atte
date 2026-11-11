//! Stateful MCP peer that holds tools/list while still accepting session DELETE.
use super::*;
use crate::mcp::check::Status;
use std::{
    io::{BufRead, Read, Write},
    net::{TcpListener, TcpStream},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    thread,
    time::Duration,
};
use tokio_util::sync::CancellationToken;
struct Peer {
    url: String,
    stop: Arc<AtomicBool>,
    lists: Arc<AtomicUsize>,
    deleted: Arc<AtomicUsize>,
    task: Option<thread::JoinHandle<()>>,
}
impl Peer {
    fn start(mode: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let lists = Arc::new(AtomicUsize::new(0));
        let deleted = Arc::new(AtomicUsize::new(0));
        let (stopping, listing, deleting) = (stop.clone(), lists.clone(), deleted.clone());
        let task = thread::spawn(move || {
            let mut requests = vec![];
            while !stopping.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let (stop, lists, deleted) =
                            (stopping.clone(), listing.clone(), deleting.clone());
                        requests.push(thread::spawn(move || {
                            handle(stream, mode, &stop, &lists, &deleted).unwrap()
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("Accept failed: {error}"),
                }
            }
            for request in requests {
                request.join().unwrap();
            }
        });
        Self {
            url,
            stop,
            lists,
            deleted,
            task: Some(task),
        }
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.task.take().unwrap().join().unwrap();
    }
}
fn handle(
    mut stream: TcpStream,
    mode: &str,
    stop: &AtomicBool,
    lists: &AtomicUsize,
    deleted: &AtomicUsize,
) -> Result<(), Box<dyn std::error::Error>> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut reader = std::io::BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let method = line
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string();
    let mut length = 0;
    loop {
        line.clear();
        reader.read_line(&mut line)?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.trim().split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>()?;
            }
        }
    }
    if method == "GET" || method == "DELETE" {
        if method == "DELETE" {
            deleted.fetch_add(1, Ordering::AcqRel);
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
        return Ok(());
    }
    assert!(length < 16384);
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    let request: Value = serde_json::from_slice(&bytes)?;
    if request["method"] == "notifications/initialized" {
        write!(
            stream,
            "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )?;
        return Ok(());
    }
    let result = if request["method"] == "initialize" {
        json!({"jsonrpc":"2.0","id":request["id"],"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"cleanup-fixture","version":"1"}}})
    } else {
        assert_eq!(request["method"], "tools/list");
        lists.fetch_add(1, Ordering::AcqRel);
        if mode != "error" {
            stream.set_read_timeout(Some(Duration::from_millis(20)))?;
            let mut byte = [0; 1];
            while !stop.load(Ordering::Acquire) {
                match stream.read(&mut byte) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) => {}
                    Err(_) => break,
                }
            }
            return Ok(());
        }
        json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32603,"message":"hidden-token"}})
    };
    let body = result.to_string();
    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: cleanup-session\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len())?;
    stream.flush()?;
    Ok(())
}
#[tokio::test]
#[ignore = "Binds a loopback MCP fixture; requires local network access"]
async fn failed_cancelled_and_timed_out_checks_await_remote_session_cleanup() {
    for (mode, status) in [
        ("error", Status::ProtocolError),
        ("cancel", Status::Cancelled),
        ("timeout", Status::Timeout),
    ] {
        let peer = Peer::start(mode);
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path(), Arc::new(MemoryCredentials::default()));
        service
            .save(
                &Target::Global,
                "remote",
                Server {
                    enabled: false,
                    transport: Transport::Http {
                        url: peer.url.clone(),
                        headers: BTreeMap::new(),
                    },
                },
                BTreeMap::new(),
                true,
            )
            .unwrap();
        let prepared = service
            .prepare_check(&Target::Global, "remote", root.path().into())
            .unwrap();
        let cancel = CancellationToken::new();
        let cancelling = cancel.clone();
        let lists = peer.lists.clone();
        let task = tokio::spawn(async move {
            if mode == "cancel" {
                for _ in 0..1000 {
                    if lists.load(Ordering::Acquire) > 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
                cancelling.cancel();
            }
        });
        let result = service
            .run_check(prepared, cancel, Duration::from_secs(1))
            .await;
        task.await.unwrap();
        assert_eq!(result.status, status, "{mode}");
        assert_eq!(peer.lists.load(Ordering::Acquire), 1, "{mode}");
        assert_eq!(
            peer.deleted.load(Ordering::Acquire),
            1,
            "cleanup must finish before returning {mode}"
        );
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("hidden-token"));
    }
}
