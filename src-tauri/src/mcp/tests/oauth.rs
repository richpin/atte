//! OAuth integration tests at the authorization and transport boundaries.
use super::*;
use axum::http::StatusCode;
use std::sync::atomic::Ordering;
use tokio_util::sync::CancellationToken;
#[path = "../../../tests/fixtures/oauth_peer.rs"]
mod peer;
use peer::Peer;
impl Peer {
    fn register(&self, service: &Mcp, name: &str, client: Option<&str>) {
        service.save(&Target::Global, name, serde_json::from_value(json!({"type":"http", "url":self.url,"oauth": client.map(|id| json!({"clientId":id})).unwrap_or(json!({}))})).unwrap(), BTreeMap::new(), true).unwrap();
    }
}
#[tokio::test]
#[ignore = "Binds real loopback OAuth and MCP peers"]
async fn login_validates_pkce_restores_and_serializes_rotating_refresh_then_logout_revokes_relays()
{
    let peer = Peer::start().await;
    peer.state.short_token.store(true, Ordering::SeqCst);
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    let service = Arc::new(service(root.path(), credentials.clone()));
    peer.register(&service, "tool", None);
    let auth = service.authorization(&Target::Global, "tool").unwrap();
    auth.login(|url| peer.browser(url, None)).await.unwrap();
    assert_eq!(peer.state.registrations.load(Ordering::SeqCst), 1);
    // Restore through a new service, without inspecting credential internals.
    let reopened = Arc::new(super::service(root.path(), credentials.clone()));
    let restored = reopened.authorization(&Target::Global, "tool").unwrap();
    let (first, second) = tokio::join!(restored.token(), restored.token());
    assert_eq!(
        (first.unwrap(), second.unwrap()),
        ("fixture-access-2".into(), "fixture-access-2".into())
    );
    assert_eq!(peer.state.refreshes.load(Ordering::SeqCst), 1);
    let (servers, state, leases) = reopened
        .resolve_session(root.path().into(), root.path().into(), true, Arc::default())
        .await
        .unwrap();
    assert!(state.issues.is_empty());
    let McpServer::Http(server) = &servers[0] else {
        panic!("Expected HTTP relay");
    };
    assert_ne!(server.url, peer.url);
    assert!(!serde_json::to_string(&servers)
        .unwrap()
        .contains("fixture-access"));
    let prepared = reopened
        .prepare_check(&Target::Global, "tool", root.path().into())
        .unwrap();
    assert_eq!(
        reopened
            .run_check(
                prepared,
                CancellationToken::new(),
                std::time::Duration::from_secs(5)
            )
            .await
            .status,
        crate::mcp::check::Status::Connected
    );
    let client = reqwest::Client::new();
    assert_eq!(
        client.post(&server.url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    restored.logout().await.unwrap();
    let response = client
        .post(&server.url)
        .header("authorization", &server.headers[0].value)
        .send()
        .await;
    assert!(response.is_err() || response.unwrap().status() == StatusCode::UNAUTHORIZED);
    assert!(restored.token().await.is_err());
    assert!(
        super::service(root.path(), credentials)
            .snapshot(&Target::Global)
            .authentication["tool"]
            == crate::mcp::oauth::Status::Required
    );
    let settings = std::fs::read_to_string(root.path().join("settings.json")).unwrap();
    assert!(!settings.contains("fixture-access") && !settings.contains("fixture-refresh"));
    drop(leases);
}

#[tokio::test]
#[ignore = "Binds a loopback OAuth peer"]
async fn failed_keychain_cleanup_never_leaves_sign_in_in_progress() {
    let peer = Peer::start().await;
    let root = tempfile::tempdir().unwrap();
    let service = service(
        root.path(),
        Arc::new(DeleteFailure(MemoryCredentials::default())),
    );
    peer.register(&service, "tool", Some("pre-registered"));
    let auth = service.authorization(&Target::Global, "tool").unwrap();
    assert!(auth
        .login(|_| Err("Browser unavailable".into()))
        .await
        .is_err());
    assert!(
        service.snapshot(&Target::Global).authentication["tool"]
            == crate::mcp::oauth::Status::Required
    );
}

#[tokio::test]
#[ignore = "Binds loopback OAuth callbacks"]
async fn cancellation_bad_state_bad_issuer_and_refresh_rejection_allow_sign_in_again() {
    let peer = Peer::start().await;
    let root = tempfile::tempdir().unwrap();
    let service = Arc::new(service(root.path(), Arc::new(MemoryCredentials::default())));
    peer.register(&service, "tool", Some("pre-registered"));
    let auth = service.authorization(&Target::Global, "tool").unwrap();
    for invalid in ["state", "issuer"] {
        let error = auth
            .login(|url| peer.browser(url, Some(invalid)))
            .await
            .unwrap_err();
        assert!(!error.contains("state=") && !error.contains("code="));
        assert!(auth.token().await.is_err());
    }
    assert!(auth
        .login(|_| {
            auth.cancel();
            Ok(())
        })
        .await
        .is_err());
    assert!(auth.status() == crate::mcp::oauth::Status::Required);
    peer.state.short_token.store(true, Ordering::SeqCst);
    auth.login(|url| peer.browser(url, None)).await.unwrap();
    peer.state.reject_refresh.store(true, Ordering::SeqCst);
    assert!(auth.token().await.is_err());
    assert!(auth.status() == crate::mcp::oauth::Status::ReauthorizationRequired);
    peer.state.reject_refresh.store(false, Ordering::SeqCst);
    peer.state.short_token.store(false, Ordering::SeqCst);
    auth.login(|url| peer.browser(url, None)).await.unwrap();
    assert_eq!(peer.state.registrations.load(Ordering::SeqCst), 0);
    assert_eq!(auth.token().await.unwrap(), "fixture-access-1");
}

fn application() -> PathBuf {
    static EXECUTABLE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    EXECUTABLE
        .get_or_init(|| {
            let output = std::process::Command::new(env!("CARGO"))
                .current_dir(env!("CARGO_MANIFEST_DIR"))
                .args([
                    "build",
                    "--offline",
                    "--locked",
                    "--bin",
                    "atte",
                    "--message-format=json",
                ])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find_map(|message| {
                    (message["reason"] == "compiler-artifact"
                        && message["target"]["name"] == "atte")
                        .then(|| message["executable"].as_str().map(PathBuf::from))
                        .flatten()
                })
                .unwrap()
        })
        .clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Runs ACP, OAuth HTTP peers and the real headless application executable"]
async fn acp_new_load_resume_use_oauth_over_http_and_headless_stdio_without_crossing_threads() {
    let executable = application();
    let agent_executable = fixture();
    for http in [true, false] {
        for mode in ["normal", "resume-only"] {
            let peer = Peer::start().await;
            let root = tempfile::tempdir().unwrap();
            let mut mcp = service(root.path(), Arc::new(MemoryCredentials::default()));
            // The test runner is not the packaged app. Supply the actual app executable
            // at the same launch-context boundary used by Tauri setup.
            mcp.executable = executable.clone();
            let service = Arc::new(mcp);
            peer.register(&service, "tool", None);
            service
                .authorization(&Target::Global, "tool")
                .unwrap()
                .login(|url| peer.browser(url, None))
                .await
                .unwrap();
            let log = root.path().join("requests.log");
            let mut env = std::collections::HashMap::from([
                ("FIXTURE_MODE".into(), mode.into()),
                ("MCP_LOG".into(), log.to_string_lossy().into()),
            ]);
            if http {
                env.insert("MCP_HTTP".into(), "1".into());
            }
            let agent = crate::agent::AgentDefinition {
                id: "fixture".into(),
                name: "Fixture".into(),
                launch_kind: Default::default(),
                command: agent_executable.clone(),
                args: vec![],
                env,
                node_runtime: None,
            };
            let threads = crate::thread::Threads::new(vec![agent]);
            threads.set_mcp(service.clone());
            let first = threads.create(root.path()).unwrap();
            let second = threads.create(root.path()).unwrap();
            for id in [first.id, second.id] {
                threads.connect(id).unwrap();
                let connected = ready(&threads, id).await;
                assert!(
                    connected.mcp.issues.is_empty(),
                    "{:?}",
                    connected.mcp.issues
                );
                threads.send_message(id, "Call OAuth MCP".into()).unwrap();
                let called = ready(&threads, id).await;
                assert_eq!(called.status, crate::thread::ThreadStatus::SessionReady);
                assert!(
                    serde_json::to_string(&called.turns)
                        .unwrap()
                        .contains("OAuth MCP tool result: 1"),
                    "{:?}",
                    called.status
                );
            }
            let second_session = threads.get(second.id).unwrap().session_id;
            threads.reconnect(first.id).unwrap();
            ready(&threads, first.id).await;
            threads
                .send_message(first.id, "Call after reconnect".into())
                .unwrap();
            let called = ready(&threads, first.id).await;
            assert!(serde_json::to_string(&called.turns.last())
                .unwrap()
                .contains("OAuth MCP tool result: 1"));
            assert_eq!(threads.get(second.id).unwrap().session_id, second_session);
            threads
                .send_message(second.id, "Call on the other thread after reconnect".into())
                .unwrap();
            let other_called = ready(&threads, second.id).await;
            assert!(serde_json::to_string(&other_called.turns.last())
                .unwrap()
                .contains("OAuth MCP tool result: 1"));
            assert_eq!(peer.state.calls.load(Ordering::SeqCst), 4);
            let methods = std::fs::read_to_string(&log).unwrap();
            assert!(methods.contains("session/new:tool"));
            assert!(methods.contains(if mode == "normal" {
                "session/load:tool"
            } else {
                "session/resume:tool"
            }));
            threads.shutdown().await;
            let snapshot = serde_json::to_string(&called).unwrap();
            assert!(!snapshot.contains("fixture-access") && !snapshot.contains("fixture-refresh"));
        }
    }
}

struct Bridge {
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
}
async fn bridge(server: &McpServerStdio) -> Bridge {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let mut child = tokio::process::Command::new(&server.command)
        .args(&server.args)
        .envs(server.env.iter().map(|entry| (&entry.name, &entry.value)))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    input.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"fixture\",\"version\":\"1\"}}}\n").await.unwrap();
    let initialized = tokio::time::timeout(std::time::Duration::from_secs(5), output.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(initialized.contains("oauth-fixture"));
    Bridge {
        child,
        input,
        output,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Runs the real app as a headless bridge against a loopback peer"]
async fn closing_a_connection_stops_its_idle_stdio_bridge_without_closing_stdin() {
    let executable = application();
    let peer = Peer::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut mcp = service(root.path(), Arc::new(MemoryCredentials::default()));
    mcp.executable = executable;
    let service = Arc::new(mcp);
    peer.register(&service, "tool", None);
    service
        .authorization(&Target::Global, "tool")
        .unwrap()
        .login(|url| peer.browser(url, None))
        .await
        .unwrap();
    let (servers, _, leases) = service
        .resolve_session(
            root.path().into(),
            root.path().into(),
            false,
            Arc::default(),
        )
        .await
        .unwrap();
    let McpServer::Stdio(server) = &servers[0] else {
        panic!("Expected stdio bridge");
    };
    let mut bridge = bridge(server).await;
    drop(leases);
    tokio::time::timeout(std::time::Duration::from_secs(6), bridge.child.wait())
        .await
        .expect("Idle bridge outlived its connection")
        .unwrap();
}

#[tokio::test]
#[ignore = "Binds loopback OAuth peers"]
async fn logout_invalidates_existing_relays_even_after_server_url_is_edited() {
    let first = Peer::start().await;
    let second = Peer::start().await;
    let root = tempfile::tempdir().unwrap();
    let service = Arc::new(service(root.path(), Arc::new(MemoryCredentials::default())));
    first.register(&service, "tool", None);
    let original = service.authorization(&Target::Global, "tool").unwrap();
    original
        .login(|url| first.browser(url, None))
        .await
        .unwrap();
    let (_, _, leases) = service
        .resolve_session(root.path().into(), root.path().into(), true, Arc::default())
        .await
        .unwrap();
    service
        .save(
            &Target::Global,
            "tool",
            serde_json::from_value(json!({"type":"http","url":second.url,"oauth":{}})).unwrap(),
            BTreeMap::new(),
            false,
        )
        .unwrap();
    service.logout(&Target::Global, "tool").await.unwrap();
    assert!(original.token().await.is_err());
    assert!(original.revocation().unwrap().is_cancelled());
    drop(leases);
}

#[tokio::test]
#[ignore = "Binds real loopback MCP streams"]
async fn relay_preserves_notifications_cancellation_and_streams_and_logout_ends_open_streams() {
    use futures_util::StreamExt;
    let peer = Peer::start().await;
    peer.state.stream.store(true, Ordering::SeqCst);
    let root = tempfile::tempdir().unwrap();
    let service = Arc::new(service(root.path(), Arc::new(MemoryCredentials::default())));
    peer.register(&service, "tool", None);
    service
        .authorization(&Target::Global, "tool")
        .unwrap()
        .login(|url| peer.browser(url, None))
        .await
        .unwrap();
    let (servers, _, leases) = service
        .resolve_session(root.path().into(), root.path().into(), true, Arc::default())
        .await
        .unwrap();
    let McpServer::Http(server) = &servers[0] else {
        panic!("Expected HTTP relay");
    };
    let client = reqwest::Client::new();
    let result = client.post(&server.url).header("authorization",&server.headers[0].value)
        .json(&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":42,"reason":"Cancelled"}})).send().await.unwrap();
    assert_eq!(result.status(), StatusCode::ACCEPTED);
    assert_eq!(peer.state.notifications.load(Ordering::SeqCst), 1);
    let response = client
        .get(&server.url)
        .header("authorization", &server.headers[0].value)
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut stream = response.bytes_stream();
    let chunk = stream.next().await.unwrap().unwrap();
    assert_eq!(chunk.as_ref(),b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n");
    service.logout(&Target::Global, "tool").await.unwrap();
    let end = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
        .await
        .unwrap();
    assert!(end.is_none() || end.unwrap().is_err());
    drop(leases);
}

#[tokio::test]
#[ignore = "Binds real OAuth metadata peers"]
async fn credentials_cannot_cross_project_url_or_issuer_boundaries() {
    let peer = Peer::start().await;
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    let service = service(root.path(), credentials.clone());
    peer.register(&service, "tool", None);
    service
        .authorization(&Target::Global, "tool")
        .unwrap()
        .login(|url| peer.browser(url, None))
        .await
        .unwrap();
    let project = Target::Project {
        folder: root.path().into(),
    };
    service
        .save(
            &project,
            "tool",
            serde_json::from_value(json!({"type":"http","url":peer.url,"oauth":{}})).unwrap(),
            BTreeMap::new(),
            true,
        )
        .unwrap();
    assert!(service
        .authorization(&project, "tool")
        .unwrap()
        .token()
        .await
        .is_err());
    peer.state.issuer_changed.store(true, Ordering::SeqCst);
    let reopened = super::service(root.path(), credentials);
    assert!(reopened
        .authorization(&Target::Global, "tool")
        .unwrap()
        .token()
        .await
        .is_err());
    let other = Peer::start().await;
    service
        .save(
            &Target::Global,
            "tool",
            serde_json::from_value(json!({"type":"http","url":other.url,"oauth":{}})).unwrap(),
            BTreeMap::new(),
            false,
        )
        .unwrap();
    assert!(service
        .authorization(&Target::Global, "tool")
        .unwrap()
        .token()
        .await
        .is_err());
}

#[tokio::test]
#[ignore = "Binds real MCP sessions on separate relays"]
async fn a_connection_cannot_use_another_connections_mcp_session_id() {
    let peer = Peer::start().await;
    let root = tempfile::tempdir().unwrap();
    let service = Arc::new(service(root.path(), Arc::new(MemoryCredentials::default())));
    peer.register(&service, "tool", None);
    service
        .authorization(&Target::Global, "tool")
        .unwrap()
        .login(|url| peer.browser(url, None))
        .await
        .unwrap();
    let (first, _, _first_lease) = service
        .resolve_session(root.path().into(), root.path().into(), true, Arc::default())
        .await
        .unwrap();
    let (second, _, _second_lease) = service
        .resolve_session(root.path().into(), root.path().into(), true, Arc::default())
        .await
        .unwrap();
    let (McpServer::Http(first), McpServer::Http(second)) = (&first[0], &second[0]) else {
        panic!("Expected HTTP relays");
    };
    let client = reqwest::Client::new();
    let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}});
    let initialized = client
        .post(&first.url)
        .header("authorization", &first.headers[0].value)
        .json(&init)
        .send()
        .await
        .unwrap();
    let session = initialized.headers()["mcp-session-id"].clone();
    let wrong = client.post(&second.url).header("authorization",&second.headers[0].value).header("mcp-session-id",&session)
        .json(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"where","arguments":{}}})).send().await.unwrap();
    assert_eq!(wrong.status(), StatusCode::NOT_FOUND);
    assert_eq!(peer.state.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Runs a headless bridge with a pending JSON tool response"]
async fn headless_bridge_forwards_cancellation_while_a_json_tool_call_is_pending() {
    use tokio::io::AsyncWriteExt;
    let executable = application();
    let peer = Peer::start().await;
    peer.state.hold_calls.store(true, Ordering::SeqCst);
    let root = tempfile::tempdir().unwrap();
    let mut mcp = service(root.path(), Arc::new(MemoryCredentials::default()));
    mcp.executable = executable;
    let service = Arc::new(mcp);
    peer.register(&service, "tool", None);
    service
        .authorization(&Target::Global, "tool")
        .unwrap()
        .login(|url| peer.browser(url, None))
        .await
        .unwrap();
    let (servers, _, _leases) = service
        .resolve_session(
            root.path().into(),
            root.path().into(),
            false,
            Arc::default(),
        )
        .await
        .unwrap();
    let McpServer::Stdio(server) = &servers[0] else {
        panic!("Expected stdio");
    };
    let Bridge {
        mut child,
        mut input,
        mut output,
    } = bridge(server).await;
    input.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"where\",\"arguments\":{}}}\n").await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        peer.state.call_started.notified(),
    )
    .await
    .unwrap();
    input.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":2,\"reason\":\"Cancelled\"}}\n").await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        peer.state.cancel_received.notified(),
    )
    .await
    .expect("Bridge blocked cancellation behind the pending response");
    input
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/list\"}\n")
        .await
        .unwrap();
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), output.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(response["id"], 3);
    assert_eq!(response["result"]["tools"][0]["name"], "where");
    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[tokio::test]
#[ignore = "Binds a real OAuth peer"]
async fn logout_revokes_known_connections_even_when_the_settings_file_is_invalid() {
    let peer = Peer::start().await;
    let root = tempfile::tempdir().unwrap();
    let service = Arc::new(service(root.path(), Arc::new(MemoryCredentials::default())));
    peer.register(&service, "tool", None);
    let auth = service.authorization(&Target::Global, "tool").unwrap();
    auth.login(|url| peer.browser(url, None)).await.unwrap();
    service.snapshot(&Target::Global);
    std::fs::write(root.path().join("settings.json"), "{broken").unwrap();
    let snapshot = service.snapshot(&Target::Global);
    assert!(snapshot.authentication["tool"] == crate::mcp::oauth::Status::Authorized);
    service.logout(&Target::Global, "tool").await.unwrap();
    assert!(auth.token().await.is_err());
    assert!(
        service.snapshot(&Target::Global).authentication["tool"]
            == crate::mcp::oauth::Status::Required
    );
}

#[tokio::test]
#[ignore = "Binds a real OAuth peer"]
async fn signing_in_and_out_change_connection_revision_but_token_use_does_not() {
    let peer = Peer::start().await;
    let root = tempfile::tempdir().unwrap();
    let service = Arc::new(service(root.path(), Arc::new(MemoryCredentials::default())));
    peer.register(&service, "tool", None);
    let (_, before, _) = service
        .resolve_session(root.path().into(), root.path().into(), true, Arc::default())
        .await
        .unwrap();
    assert_eq!(before.issues.len(), 1);
    let auth = service.authorization(&Target::Global, "tool").unwrap();
    auth.login(|url| peer.browser(url, None)).await.unwrap();
    assert_ne!(service.revision(root.path()), before.revision);
    let (_, connected, _lease) = service
        .resolve_session(root.path().into(), root.path().into(), true, Arc::default())
        .await
        .unwrap();
    assert_eq!(service.revision(root.path()), connected.revision);
    auth.token().await.unwrap();
    assert_eq!(service.revision(root.path()), connected.revision);
    service.logout(&Target::Global, "tool").await.unwrap();
    assert_ne!(service.revision(root.path()), connected.revision);
}

struct ReadEditingCredentials {
    values: MemoryCredentials,
    edit: Mutex<Option<(PathBuf, Value)>>,
}
impl Credentials for ReadEditingCredentials {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        if let Some((path, value)) = self.edit.lock().unwrap().take() {
            std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        }
        self.values.get(account)
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.values.set(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.values.delete(account)
    }
}
#[tokio::test]
async fn one_connection_uses_one_configuration_snapshot_even_if_credentials_trigger_an_external_edit(
) {
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(ReadEditingCredentials {
        values: MemoryCredentials::default(),
        edit: Mutex::new(None),
    });
    let service = Arc::new(service(root.path(), credentials.clone()));
    service.save(&Target::Global,"tool",serde_json::from_value(json!({"type":"http","url":"https://original.example/mcp","headers":{"X-Key":{"kind":"secret","value":""}}})).unwrap(),BTreeMap::from([("X-Key".into(),"fixture-key".into())]),true).unwrap();
    let before = service.revision(root.path());
    *credentials.edit.lock().unwrap() = Some((
        root.path().join("settings.json"),
        json!({"mcpServers":{"tool":{"type":"http","url":"https://changed.example/mcp","oauth":{}}}}),
    ));
    let (servers, state, _leases) = service
        .resolve_session(root.path().into(), root.path().into(), true, Arc::default())
        .await
        .unwrap();
    assert!(state.issues.is_empty());
    assert_eq!(servers.len(), 1);
    assert_eq!(
        serde_json::to_value(&servers).unwrap()[0]["url"],
        "https://original.example/mcp"
    );
    assert_eq!(state.revision, before);
    assert_ne!(service.revision(root.path()), before);
}

struct RecoveringCredentials {
    values: MemoryCredentials,
    fail_delete: std::sync::atomic::AtomicBool,
}
impl Credentials for RecoveringCredentials {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        self.values.get(account)
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.values.set(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        if self.fail_delete.load(Ordering::SeqCst) {
            Err("OS credential store locked".into())
        } else {
            self.values.delete(account)
        }
    }
}
#[tokio::test]
#[ignore = "Binds a real OAuth peer"]
async fn failed_logout_revokes_access_and_keeps_a_retry_action_until_credential_deletion_succeeds()
{
    let peer = Peer::start().await;
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(RecoveringCredentials {
        values: MemoryCredentials::default(),
        fail_delete: std::sync::atomic::AtomicBool::new(true),
    });
    let service = Arc::new(service(root.path(), credentials.clone()));
    peer.register(&service, "tool", None);
    let auth = service.authorization(&Target::Global, "tool").unwrap();
    auth.login(|url| peer.browser(url, None)).await.unwrap();
    assert!(service.logout(&Target::Global, "tool").await.is_err());
    assert!(auth.revocation().unwrap().is_cancelled());
    assert!(auth.token().await.is_err());
    assert!(
        service.snapshot(&Target::Global).authentication["tool"]
            == crate::mcp::oauth::Status::ReauthorizationRequired
    );
    credentials.fail_delete.store(false, Ordering::SeqCst);
    service.logout(&Target::Global, "tool").await.unwrap();
    assert!(
        super::service(root.path(), credentials)
            .snapshot(&Target::Global)
            .authentication["tool"]
            == crate::mcp::oauth::Status::Required
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Runs a headless bridge with stdout backpressure"]
async fn connection_shutdown_stops_a_bridge_even_when_the_agent_stops_reading_stdout() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let executable = application();
    let peer = Peer::start().await;
    peer.state.large_response.store(true, Ordering::SeqCst);
    let root = tempfile::tempdir().unwrap();
    let mut mcp = service(root.path(), Arc::new(MemoryCredentials::default()));
    mcp.executable = executable;
    let service = Arc::new(mcp);
    peer.register(&service, "tool", None);
    service
        .authorization(&Target::Global, "tool")
        .unwrap()
        .login(|url| peer.browser(url, None))
        .await
        .unwrap();
    let (servers, _, leases) = service
        .resolve_session(
            root.path().into(),
            root.path().into(),
            false,
            Arc::default(),
        )
        .await
        .unwrap();
    let McpServer::Stdio(server) = &servers[0] else {
        panic!("Expected stdio");
    };
    let Bridge {
        mut child,
        mut input,
        mut output,
    } = bridge(server).await;
    input.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n").await.unwrap();
    let mut byte = [0];
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        output.get_mut().read_exact(&mut byte),
    )
    .await
    .unwrap()
    .unwrap();
    drop(leases);
    tokio::time::timeout(std::time::Duration::from_secs(6), child.wait())
        .await
        .expect("Blocked stdout outlived its connection")
        .unwrap();
}
