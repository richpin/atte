use super::*;
use crate::mcp::check::Status;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn local(service: &Mcp, root: &Path, mode: &str) {
    let server = Server {
        enabled: false,
        transport: Transport::Stdio {
            command: fixture().to_string_lossy().into(),
            args: vec!["--mcp".into()],
            env: BTreeMap::from([
                ("MCP_CHECK_MODE".into(), ValueSource::Literal(mode.into())),
                (
                    "MCP_PID".into(),
                    ValueSource::Literal(root.join("pid").to_string_lossy().into()),
                ),
            ]),
        },
    };
    service
        .save(&Target::Global, "check", server, BTreeMap::new(), true)
        .unwrap();
}
#[tokio::test]
async fn explicit_check_initializes_lists_tools_and_preserves_disabled_registration() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    local(&service, root.path(), "normal");
    let before = std::fs::read(root.path().join("settings.json")).unwrap();
    let prepared = service
        .prepare_check(&Target::Global, "check", root.path().into())
        .unwrap();
    let result = service
        .run_check(prepared, CancellationToken::new(), Duration::from_secs(5))
        .await;
    assert_eq!(result.status, Status::Connected);
    assert_eq!(result.tools, vec!["where"]);
    assert_eq!(
        std::fs::read(root.path().join("settings.json")).unwrap(),
        before
    );
    assert_stopped(root.path());
}
#[tokio::test]
async fn empty_tools_failed_execution_timeout_and_cancellation_are_distinct_and_cleaned_up() {
    for (mode, status) in [
        ("empty", Status::NoTools),
        ("no-capabilities", Status::NoTools),
        ("fail", Status::ExecutionFailed),
        ("hang", Status::Timeout),
        ("cancel", Status::Cancelled),
    ] {
        let root = tempfile::tempdir().unwrap();
        let service = service(root.path(), Arc::new(MemoryCredentials::default()));
        local(&service, root.path(), mode);
        let prepared = service
            .prepare_check(&Target::Global, "check", root.path().into())
            .unwrap();
        let cancel = CancellationToken::new();
        let cancelling = cancel.clone();
        let pid_path = root.path().join("pid");
        let task = tokio::spawn(async move {
            if mode == "cancel" {
                for _ in 0..500 {
                    if pid_path.exists() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                cancelling.cancel();
            }
        });
        let result = service
            .run_check(prepared, cancel, Duration::from_secs(5))
            .await;
        task.await.unwrap();
        assert_eq!(result.status, status, "{mode}");
        assert_stopped(root.path());
    }
}
#[cfg(unix)]
fn assert_stopped(root: &Path) {
    let Ok(pid) = std::fs::read_to_string(root.join("pid")) else {
        return;
    };
    let pid: i32 = pid.parse().unwrap();
    assert!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err(),
        "Check process still alive"
    );
}
#[cfg(not(unix))]
fn assert_stopped(_: &Path) {}

#[tokio::test]
#[ignore = "Binds a loopback MCP fixture; requires local network access"]
async fn http_check_lists_tools_with_secret_headers_and_reports_authentication_failure() {
    let remote = super::http_session::HttpFixture::with_session(true);
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    let server: Server = serde_json::from_value(json!({"type":"http","enabled":false,"url":remote.url,"headers":{"Authorization":{"kind":"secret","value":""},"X-Api-Key":{"kind":"secret","value":""}}})).unwrap();
    service
        .save(
            &Target::Global,
            "remote",
            server,
            BTreeMap::from([
                ("Authorization".into(), "Bearer http-fixture-key".into()),
                ("X-Api-Key".into(), "custom-fixture-key".into()),
            ]),
            true,
        )
        .unwrap();
    let prepared = service
        .prepare_check(&Target::Global, "remote", root.path().into())
        .unwrap();
    let result = service
        .run_check(prepared, CancellationToken::new(), Duration::from_secs(5))
        .await;
    assert_eq!(result.status, Status::Connected);
    assert_eq!(result.tools, vec!["where"]);
    assert_eq!(
        remote.deletions.load(std::sync::atomic::Ordering::Acquire),
        1
    );
    service
        .save(
            &Target::Global,
            "remote",
            Server {
                enabled: false,
                transport: Transport::Http {
                    url: remote.url.clone(),
                    headers: BTreeMap::new(),
                },
            },
            BTreeMap::new(),
            false,
        )
        .unwrap();
    let prepared = service
        .prepare_check(&Target::Global, "remote", root.path().into())
        .unwrap();
    let result = service
        .run_check(prepared, CancellationToken::new(), Duration::from_secs(5))
        .await;
    assert_eq!(result.status, Status::AuthenticationRequired);
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("http-fixture-key"));
}
