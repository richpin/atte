use atte_lib::{
    agent::AgentDefinition,
    thread::{
        Attachment, AttachmentKind, MediaKind, QueuedMessageStatus, ThreadConfigurationValue,
        ThreadStatus, Threads, UserInput,
    },
};
use std::{path::PathBuf, process::Command, sync::OnceLock, time::Duration};

fn fixture_executable() -> &'static PathBuf {
    static EXECUTABLE: OnceLock<PathBuf> = OnceLock::new();
    EXECUTABLE.get_or_init(|| {
        // Build explicitly so a filtered `cargo test --test acp_session` works too.
        let output = Command::new(env!("CARGO"))
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .args([
                "build",
                "--locked",
                "--example",
                "acp-agent-fixture",
                "--message-format=json",
            ])
            .output()
            .expect("build the Rust ACP fixture");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .find_map(|message| {
                (message["reason"] == "compiler-artifact"
                    && message["target"]["name"] == "acp-agent-fixture")
                    .then(|| message["executable"].as_str().map(PathBuf::from))
                    .flatten()
            })
            .expect("Cargo reported the fixture executable")
    })
}

fn mock_agent() -> AgentDefinition {
    AgentDefinition {
        id: "fixture".into(),
        name: "Fixture".into(),
        launch_kind: Default::default(),
        command: fixture_executable().clone(),
        args: vec![],
        env: Default::default(),
        node_runtime: None,
    }
}

fn add_configuration_gate(agent: &mut AgentDefinition, gate: &std::path::Path) {
    std::fs::create_dir_all(gate).unwrap();
    agent
        .env
        .insert("CONFIGURATION_GATE".into(), gate.to_string_lossy().into());
}

async fn wait_for_configuration_gate(gate: &std::path::Path, request: usize, stage: &str) {
    let arrived = gate.join(format!("{request}.{stage}.arrived"));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !arrived.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn wait_for_path(path: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !path.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

fn release_configuration_gate(gate: &std::path::Path, request: usize, stage: &str) {
    std::fs::write(gate.join(format!("{request}.{stage}.release")), []).unwrap();
}

async fn wait_for_boolean_configuration(
    threads: &Threads,
    id: uuid::Uuid,
    config_id: &str,
    expected: bool,
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = threads.get(id).unwrap();
            let current = thread
                .configuration
                .iter()
                .find(|configuration| configuration.id == config_id)
                .unwrap();
            if serde_json::to_value(current).unwrap()["currentValue"] == expected {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn wait_for_select_configuration(
    threads: &Threads,
    id: uuid::Uuid,
    config_id: &str,
    expected: &str,
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = threads.get(id).unwrap();
            let current = thread
                .configuration
                .iter()
                .find(|configuration| configuration.id == config_id)
                .unwrap();
            if serde_json::to_value(current).unwrap()["currentValue"] == expected {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn persist_remote_session(
    folder: &std::path::Path,
    agent: &AgentDefinition,
) -> (std::sync::Arc<atte_lib::storage::Store>, uuid::Uuid) {
    let store =
        std::sync::Arc::new(atte_lib::storage::Store::open(&folder.join("atte.sqlite")).unwrap());
    let threads = Threads::with_store(vec![agent.clone()], store.clone()).unwrap();
    let saved = threads.create(folder).unwrap();
    threads.connect(saved.id).unwrap();
    settle(&threads, saved.id).await;
    threads.shutdown().await;
    (store, saved.id)
}

#[tokio::test]
async fn list_subscription_tracks_background_thread_status() {
    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![mock_agent()]);
    let mut list = threads.subscribe_list().unwrap();
    assert!(list.recv().await.unwrap().is_empty());
    let draft = threads.create(folder.path()).unwrap();
    assert_eq!(list.recv().await.unwrap()[0].id, draft.id);
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let ready = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let entries = list.recv().await.unwrap();
            if entries[0].status == ThreadStatus::SessionReady {
                break entries;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(ready[0].id, draft.id);
    threads.shutdown().await;
}

#[tokio::test]
async fn shutdown_stops_all_work_and_restores_queues_without_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    let threads = Threads::with_store(vec![agent.clone()], store.clone()).unwrap();
    let mut ids = Vec::new();
    for message in ["hold", "approval"] {
        let draft = threads.create(root.path()).unwrap();
        threads.connect(draft.id).unwrap();
        settle(&threads, draft.id).await;
        threads.send_message(draft.id, message.into()).unwrap();
        let mut stream = subscribe(&threads, draft.id);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let next = stream.recv().await.unwrap();
                if (message == "hold" && !next.turns[0].response.is_empty())
                    || next.status == ThreadStatus::WaitingForApproval
                {
                    break;
                }
            }
        })
        .await
        .unwrap();
        threads.send_message(draft.id, "queued".into()).unwrap();
        ids.push(draft.id);
    }
    tokio::time::timeout(Duration::from_secs(6), threads.shutdown())
        .await
        .unwrap();
    for id in &ids {
        let stopped = threads.get(*id).unwrap();
        assert_eq!(stopped.status, ThreadStatus::Disconnected);
        assert_eq!(stopped.turns[0].stop_reason.as_deref(), Some("cancelled"));
        assert!(stopped.permissions.is_empty());
        assert!(threads.send_message(*id, "late".into()).is_err());
    }
    let restored = Threads::with_store(vec![agent], store).unwrap();
    assert_eq!(restored.list().unwrap().len(), 2);
    for id in ids {
        let saved = restored.get(id).unwrap();
        assert!(saved.interrupted);
        assert!(saved.turns.is_empty());
        assert_eq!(saved.queued_messages[0].input.body, "queued");
        restored.connect(id).unwrap();
        let ready = settle(&restored, id).await;
        assert_eq!(ready.status, ThreadStatus::SessionReady);
        assert!(ready.turns.is_empty());
        assert_eq!(ready.queued_messages, saved.queued_messages);
    }
    restored.shutdown().await;
}

#[tokio::test]
async fn shutdown_delivers_turn_and_permission_cancellation_before_reaping() {
    let folder = tempfile::tempdir().unwrap();
    let receipt = folder.path().join("cancellation");
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "permission-cancel".into());
    agent
        .env
        .insert("CANCELLATION_FILE".into(), receipt.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads.send_message(draft.id, "permission".into()).unwrap();
    let mut stream = subscribe(&threads, draft.id);
    tokio::time::timeout(Duration::from_secs(5), async {
        while stream.recv().await.unwrap().status != ThreadStatus::WaitingForApproval {}
    })
    .await
    .unwrap();
    threads.shutdown().await;
    assert_eq!(
        std::fs::read_to_string(receipt).unwrap(),
        "turn and permissions cancelled"
    );
}

#[tokio::test]
async fn shared_connection_isolates_sessions_permissions_and_cancellation() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    let threads = Threads::new(vec![agent]);
    let first = threads.create(folder.path()).unwrap();
    let second = threads.create(folder.path()).unwrap();
    threads.connect(first.id).unwrap();
    settle(&threads, first.id).await;
    threads.connect(second.id).unwrap();
    let ready = settle(&threads, second.id).await;
    assert_eq!(ready.session_id.as_deref(), Some("remote-2"));
    threads.send_message(first.id, "approval".into()).unwrap();
    let mut stream = subscribe(&threads, first.id);
    let waiting = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = stream.recv().await.unwrap();
            if !thread.permissions.is_empty() {
                break thread;
            }
        }
    })
    .await
    .unwrap();
    drop(stream);
    threads
        .send_message(second.id, "independent".into())
        .unwrap();
    assert_eq!(
        settle(&threads, second.id).await.turns[0].response,
        "reply:independent"
    );
    threads.send_message(second.id, "hold".into()).unwrap();
    threads.cancel_turn(first.id, waiting.turns[0].id).unwrap();
    assert_eq!(
        settle(&threads, first.id).await.turns[0]
            .stop_reason
            .as_deref(),
        Some("cancelled")
    );
    assert_eq!(
        threads.get(second.id).unwrap().status,
        ThreadStatus::Running
    );
    let second_turn = threads.get(second.id).unwrap().turns[1].id;
    threads.cancel_turn(second.id, second_turn).unwrap();
    settle(&threads, second.id).await;
    threads.send_message(first.id, "exit".into()).unwrap();
    assert_eq!(
        settle(&threads, first.id).await.status,
        ThreadStatus::Failed
    );
    assert_eq!(
        settle(&threads, second.id).await.status,
        ThreadStatus::Failed
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn deleting_an_active_session_is_detached_and_keeps_shared_sessions_usable() {
    let folder = tempfile::tempdir().unwrap();
    let log = folder.path().join("requests.log");
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent.env.insert("DELETE_MODE".into(), "delayed".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let deleted = threads.create(folder.path()).unwrap();
    let remaining = threads.create(folder.path()).unwrap();
    threads.connect(deleted.id).unwrap();
    settle(&threads, deleted.id).await;
    threads.connect(remaining.id).unwrap();
    settle(&threads, remaining.id).await;
    threads.send_message(deleted.id, "hold".into()).unwrap();

    threads.delete(deleted.id).unwrap();

    assert!(threads.get(deleted.id).is_err());
    wait_for_request(&log, "session/delete remote-1").await;
    threads
        .send_message(remaining.id, "independent".into())
        .unwrap();
    assert_eq!(
        settle(&threads, remaining.id).await.turns[0].response,
        "reply:independent"
    );
    let requests = std::fs::read_to_string(log).unwrap();
    assert!(!requests.contains("session/cancel remote-1"));
    assert!(threads.get(deleted.id).is_err());
    threads.shutdown().await;
}

#[tokio::test]
async fn deleting_without_remote_capability_skips_the_request_and_keeps_shared_sessions_usable() {
    let folder = tempfile::tempdir().unwrap();
    let log = folder.path().join("requests.log");
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let deleted = threads.create(folder.path()).unwrap();
    let remaining = threads.create(folder.path()).unwrap();
    threads.connect(deleted.id).unwrap();
    settle(&threads, deleted.id).await;
    threads.connect(remaining.id).unwrap();
    settle(&threads, remaining.id).await;

    threads.delete(deleted.id).unwrap();
    threads
        .send_message(remaining.id, "still connected".into())
        .unwrap();

    assert_eq!(
        settle(&threads, remaining.id).await.turns[0].response,
        "reply:still connected"
    );
    assert!(!std::fs::read_to_string(log)
        .unwrap()
        .contains("session/delete"));
    threads.shutdown().await;
}

#[tokio::test]
async fn a_deleted_ready_session_finishing_does_not_close_the_shared_connection() {
    let folder = tempfile::tempdir().unwrap();
    let log = folder.path().join("requests.log");
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent.env.insert("DELETE_MODE".into(), "success".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let deleted = threads.create(folder.path()).unwrap();
    let remaining = threads.create(folder.path()).unwrap();
    threads.connect(deleted.id).unwrap();
    settle(&threads, deleted.id).await;
    threads.connect(remaining.id).unwrap();
    settle(&threads, remaining.id).await;

    threads.delete(deleted.id).unwrap();
    wait_for_request(&log, "session/delete remote-1").await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert_eq!(
        threads.get(remaining.id).unwrap().status,
        ThreadStatus::SessionReady
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn remote_delete_error_does_not_restore_the_locally_deleted_thread() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("atte.sqlite");
    let log = folder.path().join("requests.log");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent.env.insert("DELETE_MODE".into(), "error".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let threads = Threads::with_store(vec![agent], store).unwrap();
    let deleted = threads.create(folder.path()).unwrap();
    threads.connect(deleted.id).unwrap();
    settle(&threads, deleted.id).await;

    threads.delete(deleted.id).unwrap();

    wait_for_request(&log, "session/delete remote-1").await;
    assert!(threads.get(deleted.id).is_err());
    let rows: i64 = rusqlite::Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM threads WHERE id=?1",
            [deleted.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 0);
    threads.shutdown().await;
}

#[tokio::test]
async fn transport_close_during_remote_delete_does_not_restore_the_local_thread() {
    let folder = tempfile::tempdir().unwrap();
    let log = folder.path().join("requests.log");
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent.env.insert("DELETE_MODE".into(), "close".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let deleted = threads.create(folder.path()).unwrap();
    let remaining = threads.create(folder.path()).unwrap();
    threads.connect(deleted.id).unwrap();
    settle(&threads, deleted.id).await;
    threads.connect(remaining.id).unwrap();
    settle(&threads, remaining.id).await;

    threads.delete(deleted.id).unwrap();

    wait_for_request(&log, "session/delete remote-1").await;
    assert_eq!(
        settle(&threads, remaining.id).await.status,
        ThreadStatus::Failed
    );
    assert!(threads.get(deleted.id).is_err());
    threads.shutdown().await;
}

#[tokio::test]
async fn deleting_a_restored_session_sends_only_the_exact_remote_delete_request() {
    let folder = tempfile::tempdir().unwrap();
    let log = folder.path().join("requests.log");
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent.env.insert("DELETE_MODE".into(), "success".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let (store, saved) = persist_remote_session(folder.path(), &agent).await;
    std::fs::write(&log, "").unwrap();
    let restored = Threads::with_store(vec![agent], store).unwrap();

    restored.delete(saved).unwrap();

    wait_for_request(&log, "session/delete remote-1").await;
    let requests = std::fs::read_to_string(&log).unwrap();
    assert_eq!(requests, "initialize \nsession/delete remote-1\n");
    restored.shutdown().await;
}

#[tokio::test]
async fn deleting_a_restored_session_without_delete_capability_skips_remote_deletion() {
    let folder = tempfile::tempdir().unwrap();
    let log = folder.path().join("requests.log");
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let (store, saved) = persist_remote_session(folder.path(), &agent).await;
    std::fs::write(&log, "").unwrap();
    let restored = Threads::with_store(vec![agent], store).unwrap();

    restored.delete(saved).unwrap();

    wait_for_request(&log, "initialize ").await;
    let requests = std::fs::read_to_string(log).unwrap();
    assert_eq!(
        (requests.as_str(), restored.get(saved).is_err()),
        ("initialize \n", true)
    );
    restored.shutdown().await;
}

#[tokio::test]
async fn initialize_failure_during_restored_session_deletion_keeps_the_local_deletion() {
    let folder = tempfile::tempdir().unwrap();
    let log = folder.path().join("requests.log");
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent.env.insert("DELETE_MODE".into(), "success".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let (store, saved) = persist_remote_session(folder.path(), &agent).await;
    std::fs::write(&log, "").unwrap();
    agent
        .env
        .insert("DELETE_CONNECTION_MODE".into(), "init-error".into());
    let restored = Threads::with_store(vec![agent], store).unwrap();

    restored.delete(saved).unwrap();

    wait_for_request(&log, "initialize ").await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let requests = std::fs::read_to_string(log).unwrap();
    assert_eq!(
        (
            restored.get(saved).is_err(),
            requests.contains("session/delete")
        ),
        (true, false)
    );
    restored.shutdown().await;
}

#[tokio::test]
async fn deleting_a_restored_session_after_agent_removal_keeps_the_local_deletion() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    let (store, saved) = persist_remote_session(folder.path(), &agent).await;
    let restored = Threads::with_store(Vec::new(), store.clone()).unwrap();

    restored.delete(saved).unwrap();

    let reopened = Threads::with_store(Vec::new(), store).unwrap();
    assert_eq!(
        (
            restored.list().unwrap().len(),
            reopened.list().unwrap().len()
        ),
        (0, 0)
    );
    restored.shutdown().await;
}

#[tokio::test]
async fn missing_executable_during_restored_session_deletion_keeps_the_local_deletion() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    let (store, saved) = persist_remote_session(folder.path(), &agent).await;
    agent.command = folder.path().join("missing-agent");
    let restored = Threads::with_store(vec![agent], store.clone()).unwrap();

    restored.delete(saved).unwrap();

    restored.shutdown().await;
    let reopened = Threads::with_store(Vec::new(), store).unwrap();
    assert_eq!(
        (
            restored.list().unwrap().len(),
            reopened.list().unwrap().len()
        ),
        (0, 0)
    );
}

#[tokio::test]
async fn launch_failure_during_restored_session_deletion_keeps_the_local_deletion() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    let (store, saved) = persist_remote_session(folder.path(), &agent).await;
    agent.command = folder.path().to_path_buf();
    let restored = Threads::with_store(vec![agent], store.clone()).unwrap();

    restored.delete(saved).unwrap();

    restored.shutdown().await;
    let reopened = Threads::with_store(Vec::new(), store).unwrap();
    assert_eq!(
        (
            restored.list().unwrap().len(),
            reopened.list().unwrap().len()
        ),
        (0, 0)
    );
}

#[tokio::test]
async fn process_exit_during_restored_session_deletion_keeps_the_local_deletion() {
    let folder = tempfile::tempdir().unwrap();
    let log = folder.path().join("requests.log");
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent.env.insert("DELETE_MODE".into(), "success".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let (store, saved) = persist_remote_session(folder.path(), &agent).await;
    std::fs::write(&log, "").unwrap();
    agent
        .env
        .insert("DELETE_CONNECTION_MODE".into(), "exit".into());
    let restored = Threads::with_store(vec![agent], store).unwrap();

    restored.delete(saved).unwrap();

    wait_for_request(&log, "initialize ").await;
    assert!(restored.list().unwrap().is_empty());
    restored.shutdown().await;
}

#[tokio::test]
async fn authentication_failure_during_restored_session_deletion_keeps_the_local_deletion() {
    let folder = tempfile::tempdir().unwrap();
    let log = folder.path().join("requests.log");
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent.env.insert("DELETE_MODE".into(), "success".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let (store, saved) = persist_remote_session(folder.path(), &agent).await;
    std::fs::write(&log, "").unwrap();
    agent.env.insert("DELETE_MODE".into(), "auth".into());
    let restored = Threads::with_store(vec![agent], store).unwrap();

    restored.delete(saved).unwrap();

    wait_for_request(&log, "session/delete remote-1").await;
    assert!(restored.list().unwrap().is_empty());
    restored.shutdown().await;
}

#[tokio::test]
async fn delete_rpc_failure_during_restored_session_deletion_keeps_the_local_deletion() {
    let folder = tempfile::tempdir().unwrap();
    let log = folder.path().join("requests.log");
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent.env.insert("DELETE_MODE".into(), "success".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let (store, saved) = persist_remote_session(folder.path(), &agent).await;
    std::fs::write(&log, "").unwrap();
    agent.env.insert("DELETE_MODE".into(), "error".into());
    let restored = Threads::with_store(vec![agent], store).unwrap();

    restored.delete(saved).unwrap();

    wait_for_request(&log, "session/delete remote-1").await;
    assert!(restored.list().unwrap().is_empty());
    restored.shutdown().await;
}

#[tokio::test]
async fn deleting_a_restored_session_reuses_a_matching_shared_connection_without_loading_it() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("atte.sqlite");
    let log = folder.path().join("requests.log");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent.env.insert("DELETE_MODE".into(), "success".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let threads = Threads::with_store(vec![agent.clone()], store.clone()).unwrap();
    let deleted = threads.create(folder.path()).unwrap();
    let remaining = threads.create(folder.path()).unwrap();
    threads.connect(deleted.id).unwrap();
    settle(&threads, deleted.id).await;
    threads.connect(remaining.id).unwrap();
    settle(&threads, remaining.id).await;
    threads.shutdown().await;
    std::fs::write(&log, "").unwrap();
    let restored = Threads::with_store(vec![agent], store).unwrap();
    restored.connect(remaining.id).unwrap();
    settle(&restored, remaining.id).await;

    restored.delete(deleted.id).unwrap();

    wait_for_request(&log, "session/delete remote-1").await;
    let requests = std::fs::read_to_string(log).unwrap();
    assert_eq!(
        requests,
        "initialize \nsession/load remote-2\nsession/delete remote-1\n"
    );
    restored.shutdown().await;
}

#[tokio::test]
async fn shutdown_reaps_a_delete_only_connection_with_a_pending_request() {
    let folder = tempfile::tempdir().unwrap();
    let log = folder.path().join("requests.log");
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent.env.insert("DELETE_MODE".into(), "success".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let (store, saved) = persist_remote_session(folder.path(), &agent).await;
    std::fs::write(&log, "").unwrap();
    agent.env.insert("DELETE_MODE".into(), "delayed".into());
    let restored = Threads::with_store(vec![agent], store).unwrap();
    restored.delete(saved).unwrap();
    wait_for_request(&log, "session/delete remote-1").await;

    tokio::time::timeout(Duration::from_secs(2), restored.shutdown())
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires ATTE_CODEX_ACP and existing login; requests then cancels permission in a temporary folder"]
async fn real_codex_concurrent_sessions_keep_approval_and_queue_isolated() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = atte_lib::agent::prepared_codex();
    agent
        .env
        .insert("INITIAL_AGENT_MODE".into(), "read-only".into());
    let threads = Threads::new(vec![agent]);
    let first = threads.create(folder.path()).unwrap();
    let second = threads.create(folder.path()).unwrap();
    threads.connect(first.id).unwrap();
    assert_eq!(
        settle(&threads, first.id).await.status,
        ThreadStatus::SessionReady
    );
    threads.connect(second.id).unwrap();
    assert_eq!(
        settle(&threads, second.id).await.status,
        ThreadStatus::SessionReady
    );
    threads.send_message(first.id, "This is a permission UI acceptance test. Use exec_command with sandbox_permissions=require_escalated to run `printf ATTE-07 > cancelled.txt` in the working folder. Request approval and wait for it. Do not use an alternate tool or bypass approval.".into()).unwrap();
    threads
        .send_message(
            first.id,
            "Do not execute this queued instruction after cancellation.".into(),
        )
        .unwrap();
    let mut first_stream = subscribe(&threads, first.id);
    let waiting = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let thread = first_stream.recv().await.unwrap();
            if thread.status == ThreadStatus::WaitingForApproval {
                break thread;
            }
            assert!(
                matches!(thread.status, ThreadStatus::Running),
                "Expected permission: {thread:?}"
            );
        }
    })
    .await
    .unwrap();
    drop(first_stream);
    threads
        .send_message(
            second.id,
            "Do not use tools or read files. Reply with exactly ATTE-07-SECOND.".into(),
        )
        .unwrap();
    let mut second_stream = subscribe(&threads, second.id);
    let finished = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let thread = second_stream.recv().await.unwrap();
            if thread.status == ThreadStatus::SessionReady || thread.status == ThreadStatus::Failed
            {
                break thread;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(finished.status, ThreadStatus::SessionReady, "{finished:?}");
    assert!(finished.turns[0].response.contains("ATTE-07-SECOND"));
    assert_eq!(
        threads.get(first.id).unwrap().status,
        ThreadStatus::WaitingForApproval
    );
    threads.cancel_turn(first.id, waiting.turns[0].id).unwrap();
    let stopped = settle(&threads, first.id).await;
    assert_eq!(stopped.turns[0].stop_reason.as_deref(), Some("cancelled"));
    assert_eq!(stopped.queued_messages.len(), 1);
    assert!(!folder.path().join("cancelled.txt").exists());
    assert_eq!(threads.get(second.id).unwrap().turns, finished.turns);
    threads.shutdown().await;
}

#[tokio::test]
async fn queues_followups_and_dispatches_them_in_fifo_order_after_completion() {
    let folder = tempfile::tempdir().unwrap();
    let gate = folder.path().join("continue");
    let mut agent = mock_agent();
    agent
        .env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    for text in ["first", "second", "third"] {
        threads.send_message(draft.id, text.into()).unwrap();
    }
    let queued = threads.get(draft.id).unwrap();
    assert_eq!(queued.turns.len(), 1);
    std::fs::write(gate, "continue").unwrap();
    let finished = settle(&threads, draft.id).await;
    assert_eq!(
        finished
            .turns
            .iter()
            .map(|turn| turn.message.as_str())
            .collect::<Vec<_>>(),
        ["first", "second", "third"]
    );
    assert!(finished
        .turns
        .iter()
        .all(|turn| turn.stop_reason.as_deref() == Some("end_turn")));
    threads.shutdown().await;
}

#[tokio::test]
async fn sends_attachment_only_input_as_a_resource_link() {
    let folder = tempfile::tempdir().unwrap();
    let prompt_log = folder.path().join("prompts.jsonl");
    let mut agent = mock_agent();
    agent.env.insert(
        "PROMPT_JSON_LOG".into(),
        prompt_log.to_string_lossy().into(),
    );
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;

    let attachment = Attachment::file(
        uuid::Uuid::new_v4(),
        "image.png",
        "file:///tmp/a-very-long-image-name.png",
    );
    threads
        .send_input(
            draft.id,
            UserInput {
                body: String::new(),
                attachments: vec![attachment],
            },
        )
        .unwrap();
    settle(&threads, draft.id).await;

    let request: serde_json::Value =
        serde_json::from_str(std::fs::read_to_string(prompt_log).unwrap().trim()).unwrap();
    assert_eq!(
        request["prompt"],
        serde_json::json!([{
            "type": "resource_link",
            "name": "image.png",
            "uri": "file:///tmp/a-very-long-image-name.png"
        }])
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn keeps_sent_attachment_metadata_on_the_turn() {
    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![mock_agent()]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let attachment = Attachment::file(uuid::Uuid::new_v4(), "notes.txt", "file:///tmp/notes.txt");

    threads
        .send_input(
            draft.id,
            UserInput {
                body: "Review".into(),
                attachments: vec![attachment.clone()],
            },
        )
        .unwrap();
    let submitted = threads.get(draft.id).unwrap();

    assert_eq!(submitted.turns[0].attachments, vec![attachment]);
    threads.shutdown().await;
}

#[tokio::test]
async fn sends_media_content_after_text_in_selection_order_and_removes_successful_snapshots() {
    let root = tempfile::tempdir().unwrap();
    let prompt_log = root.path().join("prompts.jsonl");
    let session_file = root.path().join("session.json");
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let mut agent = mock_agent();
    agent.env.insert("MEDIA_CAPABILITIES".into(), "1".into());
    agent.env.insert(
        "PROMPT_JSON_LOG".into(),
        prompt_log.to_string_lossy().into(),
    );
    agent
        .env
        .insert("SESSION_FILE".into(), session_file.to_string_lossy().into());
    let threads = Threads::with_store(vec![agent.clone()], store.clone()).unwrap();
    let draft = threads.create(root.path()).unwrap();
    let image = Attachment::media(
        uuid::Uuid::new_v4(),
        "photo.png",
        MediaKind::Image,
        "image/png",
    );
    let audio = Attachment::media(
        uuid::Uuid::new_v4(),
        "voice.wav",
        MediaKind::Audio,
        "audio/wav",
    );
    let snapshot_directory = root
        .path()
        .join("prompt-attachments")
        .join(draft.id.to_string());
    std::fs::create_dir_all(&snapshot_directory).unwrap();
    std::fs::write(snapshot_directory.join(image.id.to_string()), [1, 2, 3]).unwrap();
    std::fs::write(snapshot_directory.join(audio.id.to_string()), [4, 5]).unwrap();
    threads.connect(draft.id).unwrap();
    let ready = settle(&threads, draft.id).await;
    assert_eq!(
        (
            ready.prompt_capabilities.image,
            ready.prompt_capabilities.audio
        ),
        (true, true)
    );

    threads
        .send_input(
            draft.id,
            UserInput {
                body: "inspect".into(),
                attachments: vec![
                    image.clone(),
                    audio.clone(),
                    Attachment::file(uuid::Uuid::new_v4(), "notes.txt", "file:///tmp/notes.txt"),
                ],
            },
        )
        .unwrap();
    settle(&threads, draft.id).await;

    let request: serde_json::Value =
        serde_json::from_str(std::fs::read_to_string(prompt_log).unwrap().trim()).unwrap();
    assert_eq!(
        request["prompt"],
        serde_json::json!([
            {"type":"text","text":"inspect"},
            {"type":"image","data":"AQID","mimeType":"image/png","_meta":{"atte/name":"photo.png"}},
            {"type":"audio","data":"BAU=","mimeType":"audio/wav","_meta":{"atte/name":"voice.wav"}},
            {"type":"resource_link","name":"notes.txt","uri":"file:///tmp/notes.txt"}
        ])
    );
    assert!(!snapshot_directory.join(image.id.to_string()).exists());
    assert!(!snapshot_directory.join(audio.id.to_string()).exists());
    threads.shutdown().await;
    drop(threads);
    let restored = Threads::with_store(vec![agent], store).unwrap();
    restored.connect(draft.id).unwrap();
    let loaded = settle(&restored, draft.id).await;
    assert_eq!(
        loaded.turns[0]
            .attachments
            .iter()
            .map(|attachment| (attachment.kind, attachment.name.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (AttachmentKind::Image, "photo.png"),
            (AttachmentKind::Audio, "voice.wav"),
            (AttachmentKind::File, "notes.txt"),
        ]
    );
    let serialized = serde_json::to_value(&loaded.turns[0].attachments).unwrap();
    assert!(serialized
        .as_array()
        .unwrap()
        .iter()
        .all(|attachment| attachment.get("data").is_none()));
    restored.shutdown().await;
}

#[tokio::test]
async fn restores_an_in_flight_direct_media_snapshot_before_the_response_finishes() {
    let root = tempfile::tempdir().unwrap();
    let database_path = root.path().join("atte.sqlite");
    let gates = root.path().join("gates");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&database_path).unwrap());
    let mut agent = mock_agent();
    agent.env.insert("MEDIA_CAPABILITIES".into(), "1".into());
    agent
        .env
        .insert("PROMPT_GATE_DIR".into(), gates.to_string_lossy().into());
    let threads = Threads::with_store(vec![agent.clone()], store).unwrap();
    let draft = threads.create(root.path()).unwrap();
    let image = Attachment::media(
        uuid::Uuid::new_v4(),
        "photo.png",
        MediaKind::Image,
        "image/png",
    );
    let snapshot = root
        .path()
        .join("prompt-attachments")
        .join(draft.id.to_string())
        .join(image.id.to_string());
    std::fs::create_dir_all(snapshot.parent().unwrap()).unwrap();
    std::fs::write(&snapshot, [1, 2, 3]).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;

    threads
        .send_input(
            draft.id,
            UserInput {
                body: "inspect".into(),
                attachments: vec![image.clone()],
            },
        )
        .unwrap();
    wait_for_path(&gates.join("1.arrived")).await;

    let restored = Threads::with_store(
        vec![agent],
        std::sync::Arc::new(atte_lib::storage::Store::open(&database_path).unwrap()),
    )
    .unwrap();
    let loaded = restored.get(draft.id).unwrap();
    assert_eq!(loaded.queued_messages[0].input.attachments, [image]);
    drop(restored.subscribe(draft.id).unwrap());
    assert!(snapshot.exists());
    drop(restored);

    std::fs::write(gates.join("1.release"), []).unwrap();
    settle(&threads, draft.id).await;
    assert!(!snapshot.exists());
    threads.shutdown().await;
}

#[tokio::test]
async fn reconnect_removes_unsupported_queued_media_and_advances_past_an_empty_failed_input() {
    let root = tempfile::tempdir().unwrap();
    let database_path = root.path().join("atte.sqlite");
    let gates = root.path().join("gates");
    let prompt_log = root.path().join("prompts.jsonl");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&database_path).unwrap());
    let original = Threads::with_store(vec![mock_agent()], store).unwrap();
    let draft = original.create(root.path()).unwrap();
    drop(original);

    let removed_only = Attachment::media(
        uuid::Uuid::new_v4(),
        "drop.png",
        MediaKind::Image,
        "image/png",
    );
    let removed_partial = Attachment::media(
        uuid::Uuid::new_v4(),
        "also-drop.png",
        MediaKind::Image,
        "image/png",
    );
    let retained = Attachment::media(
        uuid::Uuid::new_v4(),
        "keep.wav",
        MediaKind::Audio,
        "audio/wav",
    );
    let linked = Attachment::file(uuid::Uuid::new_v4(), "notes.txt", "file:///tmp/notes.txt");
    let snapshots = root
        .path()
        .join("prompt-attachments")
        .join(draft.id.to_string());
    std::fs::create_dir_all(&snapshots).unwrap();
    for attachment in [&removed_only, &removed_partial, &retained] {
        std::fs::write(snapshots.join(attachment.id.to_string()), [1, 2, 3]).unwrap();
    }
    let queued = [
        atte_lib::thread::QueuedMessage {
            id: uuid::Uuid::new_v4(),
            input: UserInput {
                body: String::new(),
                attachments: vec![removed_only.clone()],
            },
            status: QueuedMessageStatus::Failed,
        },
        atte_lib::thread::QueuedMessage {
            id: uuid::Uuid::new_v4(),
            input: UserInput {
                body: "send remaining".into(),
                attachments: vec![removed_partial.clone(), retained.clone(), linked.clone()],
            },
            status: QueuedMessageStatus::Failed,
        },
    ];
    rusqlite::Connection::open(&database_path)
        .unwrap()
        .execute(
            "UPDATE threads SET queued_messages=?2 WHERE id=?1",
            rusqlite::params![
                draft.id.to_string(),
                serde_json::to_string(&queued).unwrap()
            ],
        )
        .unwrap();

    let mut replacement = mock_agent();
    replacement
        .env
        .insert("MEDIA_CAPABILITIES".into(), "audio".into());
    replacement
        .env
        .insert("PROMPT_GATE_DIR".into(), gates.to_string_lossy().into());
    replacement.env.insert(
        "PROMPT_JSON_LOG".into(),
        prompt_log.to_string_lossy().into(),
    );
    let restored = Threads::with_store(
        vec![replacement],
        std::sync::Arc::new(atte_lib::storage::Store::open(&database_path).unwrap()),
    )
    .unwrap();
    restored.connect(draft.id).unwrap();
    wait_for_path(&gates.join("1.arrived")).await;

    assert!(!snapshots.join(removed_only.id.to_string()).exists());
    assert!(!snapshots.join(removed_partial.id.to_string()).exists());
    assert!(snapshots.join(retained.id.to_string()).exists());
    let active = restored.get(draft.id).unwrap();
    assert!(active.queued_messages.is_empty());
    assert_eq!(
        active.turns.last().unwrap().attachments,
        [retained.clone(), linked]
    );
    assert!(active.notice.is_none());
    let request: serde_json::Value = serde_json::from_str(
        std::fs::read_to_string(&prompt_log)
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        request["prompt"][0],
        serde_json::json!({"type": "text", "text": "send remaining"})
    );
    assert_eq!(request["prompt"][1]["type"], "audio");
    assert_eq!(request["prompt"][2]["type"], "resource_link");

    std::fs::write(gates.join("1.release"), []).unwrap();
    settle(&restored, draft.id).await;
    assert!(!snapshots.join(retained.id.to_string()).exists());
    restored.shutdown().await;
}

#[tokio::test]
async fn reconnect_advances_past_an_empty_pending_media_input() {
    let root = tempfile::tempdir().unwrap();
    let database_path = root.path().join("atte.sqlite");
    let original = Threads::with_store(
        vec![mock_agent()],
        std::sync::Arc::new(atte_lib::storage::Store::open(&database_path).unwrap()),
    )
    .unwrap();
    let draft = original.create(root.path()).unwrap();
    drop(original);
    let image = Attachment::media(
        uuid::Uuid::new_v4(),
        "drop.png",
        MediaKind::Image,
        "image/png",
    );
    let snapshot = root
        .path()
        .join("prompt-attachments")
        .join(draft.id.to_string())
        .join(image.id.to_string());
    std::fs::create_dir_all(snapshot.parent().unwrap()).unwrap();
    std::fs::write(&snapshot, [1, 2, 3]).unwrap();
    let queue = [
        atte_lib::thread::QueuedMessage {
            id: uuid::Uuid::new_v4(),
            input: UserInput {
                body: String::new(),
                attachments: vec![image],
            },
            status: QueuedMessageStatus::Pending,
        },
        atte_lib::thread::QueuedMessage::text(uuid::Uuid::new_v4(), "next"),
    ];
    rusqlite::Connection::open(&database_path)
        .unwrap()
        .execute(
            "UPDATE threads SET queued_messages=?2 WHERE id=?1",
            rusqlite::params![draft.id.to_string(), serde_json::to_string(&queue).unwrap()],
        )
        .unwrap();
    let restored = Threads::with_store(
        vec![mock_agent()],
        std::sync::Arc::new(atte_lib::storage::Store::open(&database_path).unwrap()),
    )
    .unwrap();
    restored.connect(draft.id).unwrap();
    let finished = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = restored.get(draft.id).unwrap();
            if thread.turns.len() == 1 && thread.status == ThreadStatus::SessionReady {
                break thread;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(finished.turns[0].message, "next");
    assert!(finished.queued_messages.is_empty());
    assert!(!snapshot.exists());
    restored.shutdown().await;
}

#[tokio::test]
async fn removes_a_queued_media_snapshot_after_its_prompt_succeeds() {
    let root = tempfile::tempdir().unwrap();
    let database_path = root.path().join("atte.sqlite");
    let gates = root.path().join("gates");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&database_path).unwrap());
    let mut agent = mock_agent();
    agent.env.insert("MEDIA_CAPABILITIES".into(), "1".into());
    agent
        .env
        .insert("PROMPT_GATE_DIR".into(), gates.to_string_lossy().into());
    let threads = Threads::with_store(vec![agent], store).unwrap();
    let draft = threads.create(root.path()).unwrap();
    let audio = Attachment::media(
        uuid::Uuid::new_v4(),
        "voice.wav",
        MediaKind::Audio,
        "audio/wav",
    );
    let snapshot = root
        .path()
        .join("prompt-attachments")
        .join(draft.id.to_string())
        .join(audio.id.to_string());
    std::fs::create_dir_all(snapshot.parent().unwrap()).unwrap();
    std::fs::write(&snapshot, [1, 2, 3]).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;

    threads.send_message(draft.id, "active".into()).unwrap();
    threads
        .send_input(
            draft.id,
            UserInput {
                body: "listen".into(),
                attachments: vec![audio.clone()],
            },
        )
        .unwrap();
    wait_for_path(&gates.join("1.arrived")).await;
    std::fs::write(gates.join("1.release"), []).unwrap();
    wait_for_path(&gates.join("2.arrived")).await;
    assert!(threads.get(draft.id).unwrap().queued_messages.is_empty());
    assert!(snapshot.exists());

    std::fs::write(gates.join("2.release"), []).unwrap();
    settle(&threads, draft.id).await;
    assert!(!snapshot.exists());
    let saved: String = rusqlite::Connection::open(&database_path)
        .unwrap()
        .query_row(
            "SELECT queued_messages FROM threads WHERE id=?1",
            [draft.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(saved, "[]");
    threads.shutdown().await;
}

#[tokio::test]
async fn rejected_media_prompt_becomes_failed_input_without_resource_link_fallback() {
    let root = tempfile::tempdir().unwrap();
    let prompt_log = root.path().join("prompts.jsonl");
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let mut agent = mock_agent();
    agent.env.insert("MEDIA_CAPABILITIES".into(), "1".into());
    agent
        .env
        .insert("FIXTURE_MODE".into(), "prompt-error".into());
    agent.env.insert(
        "PROMPT_JSON_LOG".into(),
        prompt_log.to_string_lossy().into(),
    );
    let threads = Threads::with_store(vec![agent], store).unwrap();
    let draft = threads.create(root.path()).unwrap();
    let image = Attachment::media(
        uuid::Uuid::new_v4(),
        "photo.png",
        MediaKind::Image,
        "image/png",
    );
    let snapshot = root
        .path()
        .join("prompt-attachments")
        .join(draft.id.to_string())
        .join(image.id.to_string());
    std::fs::create_dir_all(snapshot.parent().unwrap()).unwrap();
    std::fs::write(&snapshot, [1, 2, 3]).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;

    threads
        .send_input(
            draft.id,
            UserInput {
                body: String::new(),
                attachments: vec![image.clone()],
            },
        )
        .unwrap();
    let failed = settle(&threads, draft.id).await;

    assert_eq!(
        failed.queued_messages[0].status,
        QueuedMessageStatus::Failed
    );
    assert_eq!(failed.queued_messages[0].input.attachments, [image]);
    assert!(snapshot.exists());
    assert!(!std::fs::read_to_string(prompt_log)
        .unwrap()
        .contains("resource_link"));
    threads.shutdown().await;
}

#[tokio::test]
async fn uses_the_first_attachment_basename_as_an_empty_body_title() {
    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![mock_agent()]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let attachment_name = format!("{}-image.png", "a".repeat(65));

    threads
        .send_input(
            draft.id,
            UserInput {
                body: String::new(),
                attachments: vec![Attachment::file(
                    uuid::Uuid::new_v4(),
                    attachment_name.clone(),
                    "file:///tmp/image.png",
                )],
            },
        )
        .unwrap();
    let submitted = threads.get(draft.id).unwrap();

    assert_eq!(
        submitted.title,
        attachment_name.chars().take(60).collect::<String>()
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn queued_resource_links_keep_selection_order_after_source_files_disappear() {
    let folder = tempfile::tempdir().unwrap();
    let gates = folder.path().join("gates");
    let prompt_log = folder.path().join("prompts.jsonl");
    let first = folder.path().join("first.txt");
    let second = folder.path().join("second.mp3");
    std::fs::write(&first, "first").unwrap();
    std::fs::write(&second, "second").unwrap();
    let mut agent = mock_agent();
    agent
        .env
        .insert("PROMPT_GATE_DIR".into(), gates.to_string_lossy().into());
    agent.env.insert(
        "PROMPT_JSON_LOG".into(),
        prompt_log.to_string_lossy().into(),
    );
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads.send_message(draft.id, "active".into()).unwrap();
    wait_for_path(&gates.join("1.arrived")).await;
    threads
        .send_input(
            draft.id,
            UserInput {
                body: "inspect".into(),
                attachments: vec![
                    Attachment::file(uuid::Uuid::new_v4(), "first.txt", "file:///tmp/first.txt"),
                    Attachment::file(uuid::Uuid::new_v4(), "second.mp3", "file:///tmp/second.mp3"),
                ],
            },
        )
        .unwrap();
    std::fs::remove_file(first).unwrap();
    std::fs::remove_file(second).unwrap();
    std::fs::write(gates.join("1.release"), []).unwrap();
    wait_for_path(&gates.join("2.arrived")).await;
    std::fs::write(gates.join("2.release"), []).unwrap();
    settle(&threads, draft.id).await;

    let requests = std::fs::read_to_string(prompt_log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        requests[1]["prompt"],
        serde_json::json!([
            { "type": "text", "text": "inspect" },
            { "type": "resource_link", "name": "first.txt", "uri": "file:///tmp/first.txt" },
            { "type": "resource_link", "name": "second.mp3", "uri": "file:///tmp/second.mp3" }
        ])
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn queued_input_is_acknowledged_before_its_turn_completes() {
    let folder = tempfile::tempdir().unwrap();
    let gates = folder.path().join("gates");
    let mut agent = mock_agent();
    agent
        .env
        .insert("PROMPT_GATE_DIR".into(), gates.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads.send_message(draft.id, "active".into()).unwrap();
    threads.send_message(draft.id, "queued".into()).unwrap();
    wait_for_path(&gates.join("1.arrived")).await;
    std::fs::write(gates.join("1.release"), []).unwrap();
    wait_for_path(&gates.join("2.arrived")).await;

    let dispatched = threads.get(draft.id).unwrap();
    assert_eq!(
        (
            dispatched.status,
            dispatched.queued_messages,
            dispatched.turns.last().unwrap().message.as_str(),
        ),
        (ThreadStatus::Running, Vec::new(), "queued")
    );

    std::fs::write(gates.join("2.release"), []).unwrap();
    settle(&threads, draft.id).await;
    threads.shutdown().await;
}

#[tokio::test]
async fn failed_queued_input_blocks_fifo_until_the_user_retries_the_same_input() {
    let folder = tempfile::tempdir().unwrap();
    let gate = folder.path().join("continue");
    let prompt_log = folder.path().join("prompts.log");
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "queued-prompt-error-once".into());
    agent
        .env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    agent
        .env
        .insert("PROMPT_LOG".into(), prompt_log.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads.send_message(draft.id, "active".into()).unwrap();
    threads.send_message(draft.id, "retry me".into()).unwrap();
    threads.send_message(draft.id, "after me".into()).unwrap();
    std::fs::write(gate, "continue").unwrap();

    let failed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = threads.get(draft.id).unwrap();
            if thread
                .queued_messages
                .first()
                .is_some_and(|queued| queued.status == QueuedMessageStatus::Failed)
            {
                break thread;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(failed.queued_messages.len(), 2);
    assert_eq!(failed.queued_messages[0].input.body, "retry me");
    assert_eq!(failed.queued_messages[1].input.body, "after me");
    assert_eq!(
        std::fs::read_to_string(&prompt_log).unwrap(),
        "active\nretry me\n"
    );
    threads.send_message(draft.id, "newest".into()).unwrap();
    let blocked = threads.get(draft.id).unwrap();
    assert_eq!(blocked.queued_messages.len(), 3);
    assert_eq!(blocked.queued_messages[2].input.body, "newest");
    assert_eq!(
        std::fs::read_to_string(&prompt_log).unwrap(),
        "active\nretry me\n"
    );

    threads
        .retry_queued_message(draft.id, failed.queued_messages[0].id)
        .unwrap();
    let completed = settle(&threads, draft.id).await;

    assert!(completed.queued_messages.is_empty());
    assert_eq!(
        completed
            .turns
            .iter()
            .map(|turn| turn.message.as_str())
            .collect::<Vec<_>>(),
        ["active", "retry me", "after me", "newest"]
    );
    assert_eq!(
        std::fs::read_to_string(prompt_log).unwrap(),
        "active\nretry me\nretry me\nafter me\nnewest\n"
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn restored_legacy_text_only_queue_still_dispatches() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("queue.sqlite");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let original = Threads::with_store(vec![mock_agent()], store).unwrap();
    let draft = original.create(folder.path()).unwrap();
    original.shutdown().await;
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE threads SET queued_messages=?2 WHERE id=?1",
            rusqlite::params![
                draft.id.to_string(),
                serde_json::json!([{ "id": uuid::Uuid::new_v4(), "text": "legacy" }]).to_string()
            ],
        )
        .unwrap();
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let threads = Threads::with_store(vec![mock_agent()], store).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;

    threads.send_message(draft.id, "trigger".into()).unwrap();
    let completed = settle(&threads, draft.id).await;

    assert!(completed.queued_messages.is_empty());
    assert_eq!(
        completed
            .turns
            .iter()
            .map(|turn| turn.message.as_str())
            .collect::<Vec<_>>(),
        ["trigger", "legacy"]
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn deleting_failed_queued_input_resumes_the_next_input() {
    let folder = tempfile::tempdir().unwrap();
    let gate = folder.path().join("continue");
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "queued-prompt-error-once".into());
    agent
        .env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    for text in ["active", "delete me", "continue"] {
        threads.send_message(draft.id, text.into()).unwrap();
    }
    std::fs::write(gate, "continue").unwrap();
    let failed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = threads.get(draft.id).unwrap();
            if thread
                .queued_messages
                .first()
                .is_some_and(|queued| queued.status == QueuedMessageStatus::Failed)
            {
                break thread;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    threads
        .delete_queued_message(draft.id, failed.queued_messages[0].id)
        .unwrap();
    let completed = settle(&threads, draft.id).await;

    assert!(completed.queued_messages.is_empty());
    assert_eq!(
        completed
            .turns
            .iter()
            .map(|turn| turn.message.as_str())
            .collect::<Vec<_>>(),
        ["active", "continue"]
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn cancellation_intent_prevents_queue_dispatch_even_when_completion_wins_on_the_agent() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "cancel-race".into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads.send_message(draft.id, "first".into()).unwrap();
    threads.send_message(draft.id, "keep".into()).unwrap();
    let turn = threads.get(draft.id).unwrap().turns[0].id;
    threads.cancel_turn(draft.id, turn).unwrap();
    let stopped = settle(&threads, draft.id).await;
    assert!(stopped.interrupted);
    assert_eq!(stopped.turns.len(), 1);
    assert_eq!(stopped.queued_messages[0].input.body, "keep");
    threads.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_queue_storage_does_not_acknowledge_or_send_input() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("queue.sqlite");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "cancel".into());
    let threads = Threads::with_store(vec![agent], store).unwrap();
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads.send_message(draft.id, "first".into()).unwrap();
    let mut updates = subscribe(&threads, draft.id);
    tokio::time::timeout(Duration::from_secs(5), async {
        while updates.recv().await.unwrap().turns[0].response.is_empty() {}
    })
    .await
    .unwrap();
    // Another SQLite client holds the storage boundary unavailable.
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(threads
        .send_message(draft.id, "must not be acknowledged".into())
        .is_err());
    writer.execute_batch("ROLLBACK").unwrap();
    let thread = threads.get(draft.id).unwrap();
    assert!(thread.queued_messages.is_empty());
    threads.cancel_turn(draft.id, thread.turns[0].id).unwrap();
    assert_eq!(settle(&threads, draft.id).await.turns.len(), 1);
    threads.shutdown().await;
}

#[tokio::test]
async fn failed_removal_storage_keeps_the_followup_without_dispatching_it() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("queue.sqlite");
    let gate = folder.path().join("continue");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let mut agent = mock_agent();
    agent
        .env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    let threads = Threads::with_store(vec![agent.clone()], store.clone()).unwrap();
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads.send_message(draft.id, "first".into()).unwrap();
    threads.send_message(draft.id, "keep".into()).unwrap();
    let mut updates = subscribe(&threads, draft.id);
    tokio::time::timeout(Duration::from_secs(5), async {
        while updates.recv().await.unwrap().turns[0].response != "Hello" {}
    })
    .await
    .unwrap();
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.execute_batch("BEGIN EXCLUSIVE").unwrap();
    std::fs::write(gate, "continue").unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let thread = updates.recv().await.unwrap();
            if thread.status == ThreadStatus::SessionReady {
                break thread;
            }
        }
    })
    .await
    .unwrap();
    writer.execute_batch("ROLLBACK").unwrap();
    assert_eq!(completed.turns.len(), 2);
    assert_eq!(completed.turns[0].stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(completed.queued_messages[0].input.body, "keep");
    assert!(completed.notice.is_some());
    threads.shutdown().await;
    let restored = Threads::with_store(vec![agent], store).unwrap();
    assert_eq!(
        restored.get(draft.id).unwrap().queued_messages,
        completed.queued_messages
    );
}

#[tokio::test]
async fn cancelled_queue_survives_restart_and_load_without_sending() {
    let folder = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&folder.path().join("queue.sqlite")).unwrap(),
    );
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "cancel".into());
    let threads = Threads::with_store(vec![agent.clone()], store.clone()).unwrap();
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads.send_message(draft.id, "first".into()).unwrap();
    threads.send_message(draft.id, "keep".into()).unwrap();
    threads.send_message(draft.id, "delete".into()).unwrap();
    let queued = threads.get(draft.id).unwrap();
    threads
        .delete_queued_message(draft.id, queued.queued_messages[1].id)
        .unwrap();
    threads.cancel_turn(draft.id, queued.turns[0].id).unwrap();
    let stopped = settle(&threads, draft.id).await;
    assert_eq!(stopped.turns.len(), 1);
    assert_eq!(
        stopped
            .queued_messages
            .iter()
            .map(|message| message.input.body.as_str())
            .collect::<Vec<_>>(),
        ["keep"]
    );
    threads.shutdown().await;
    drop(threads);
    let restored = Threads::with_store(vec![agent], store).unwrap();
    assert_eq!(
        restored.get(draft.id).unwrap().queued_messages,
        stopped.queued_messages
    );
    restored.connect(draft.id).unwrap();
    let loaded = settle(&restored, draft.id).await;
    assert_eq!(loaded.queued_messages, stopped.queued_messages);
    assert!(loaded.turns.is_empty());
    restored.shutdown().await;
}

#[tokio::test]
async fn restores_agent_history_after_restart_without_persisting_a_transcript() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("atte.sqlite");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "history".into());
    agent.env.insert(
        "SESSION_FILE".into(),
        root.path()
            .join("agent-history.json")
            .to_string_lossy()
            .into(),
    );
    let threads = Threads::with_store(vec![agent.clone()], store.clone()).unwrap();
    let draft = threads.create(root.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads
        .send_message(draft.id, "Remember my marker".into())
        .unwrap();
    let original = settle(&threads, draft.id).await;
    threads.shutdown().await;
    drop(threads);
    let restored = Threads::with_store(vec![agent], store).unwrap();
    assert!(restored.get(draft.id).unwrap().turns.is_empty());
    assert_eq!(restored.list().unwrap()[0].session_id, original.session_id);
    restored.connect(draft.id).unwrap();
    restored.connect(draft.id).unwrap();
    let loaded = settle(&restored, draft.id).await;
    assert_eq!(loaded.status, ThreadStatus::SessionReady);
    assert_eq!(loaded.turns.len(), 1);
    assert_eq!(loaded.turns[0].message, "Remember my marker");
    assert_eq!(loaded.turns[0].response, "Hello world");
    restored.connect(draft.id).unwrap();
    assert_eq!(restored.get(draft.id).unwrap().turns.len(), 1);
    restored.send_message(draft.id, "Follow up".into()).unwrap();
    assert_eq!(settle(&restored, draft.id).await.turns.len(), 2);
    restored.shutdown().await;
    // Storage contents are part of this ticket's explicit no-transcript contract.
    let bytes = std::fs::read(&path).unwrap();
    assert!(!bytes
        .windows(b"Hello world".len())
        .any(|slice| slice == b"Hello world"));
}

#[tokio::test]
async fn resume_only_restores_context_with_an_explicit_no_history_notice() {
    let root = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "resume-only".into());
    let first = Threads::with_store(vec![agent.clone()], store.clone()).unwrap();
    let draft = first.create(root.path()).unwrap();
    first.connect(draft.id).unwrap();
    settle(&first, draft.id).await;
    first.shutdown().await;
    let restored = Threads::with_store(vec![agent], store).unwrap();
    restored.connect(draft.id).unwrap();
    let ready = settle(&restored, draft.id).await;
    assert_eq!(ready.status, ThreadStatus::SessionReady);
    assert!(ready
        .notice
        .as_deref()
        .unwrap_or_default()
        .contains("이전 메시지"));
    assert!(ready.turns.is_empty());
    restored.send_message(draft.id, "continue".into()).unwrap();
    let continued = settle(&restored, draft.id).await;
    assert!(continued.notice.is_some());
    restored.reconnect(draft.id).unwrap();
    let reconnected = settle(&restored, draft.id).await;
    assert_eq!(reconnected.turns, continued.turns);
    assert_eq!(reconnected.session_id, continued.session_id);
    restored.shutdown().await;
}

#[tokio::test]
async fn repeated_connection_failures_have_distinct_live_notifications() {
    use atte_lib::thread::ThreadUpdate;

    let root = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.command = root.path().join("missing-agent");
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(root.path()).unwrap();
    let mut updates = threads.subscribe(draft.id).unwrap();
    assert!(matches!(
        updates.recv().await,
        Some(ThreadUpdate::Thread { .. })
    ));
    let mut notifications = Vec::new();
    for _ in 0..2 {
        threads.reconnect(draft.id).unwrap();
        let failed = settle(&threads, draft.id).await;
        assert_eq!(failed.status, ThreadStatus::Failed);
        while let Ok(update) = updates.try_recv() {
            if let ThreadUpdate::Patch { errors, .. } = update {
                notifications.extend(errors);
            }
        }
    }
    assert_eq!(notifications.len(), 2);
    assert_ne!(notifications[0].id, notifications[1].id);
    assert_eq!(notifications[0].failure, notifications[1].failure);
    let mut restored_subscription = threads.subscribe(draft.id).unwrap();
    assert!(matches!(
        restored_subscription.recv().await,
        Some(ThreadUpdate::Thread { .. })
    ));
    assert!(restored_subscription.try_recv().is_err());
    threads.shutdown().await;
}

#[tokio::test]
async fn failed_restoration_keeps_the_reference_and_never_exposes_partial_replay() {
    use atte_lib::thread::ConnectionFailure;
    for (mode, failure) in [
        ("no-resume", ConnectionFailure::ResumptionUnsupported),
        ("load-error", ConnectionFailure::SessionRestorationFailed),
        ("load-auth", ConnectionFailure::AuthenticationRequired),
        ("load-exit", ConnectionFailure::ProcessExited),
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(
            atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
        );
        let mut agent = mock_agent();
        agent.env.insert(
            "SESSION_FILE".into(),
            root.path().join("agent.json").to_string_lossy().into(),
        );
        let first = Threads::with_store(vec![agent.clone()], store.clone()).unwrap();
        let draft = first.create(root.path()).unwrap();
        first.connect(draft.id).unwrap();
        settle(&first, draft.id).await;
        first.send_message(draft.id, "remember".into()).unwrap();
        settle(&first, draft.id).await;
        first.shutdown().await;
        agent.env.insert("FIXTURE_MODE".into(), mode.into());
        let restored = Threads::with_store(vec![agent.clone()], store).unwrap();
        restored.connect(draft.id).unwrap();
        let failed = settle(&restored, draft.id).await;
        assert_eq!(failed.failure, Some(failure), "{mode}");
        assert_eq!(failed.session_id.as_deref(), Some("remote-1"));
        assert!(failed.turns.is_empty());
        assert!(failed.permissions.is_empty());
        agent.env.remove("FIXTURE_MODE");
        restored.register_agent(agent).unwrap();
        assert_eq!(restored.get(draft.id).unwrap().status, ThreadStatus::Failed);
        restored.connect(draft.id).unwrap();
        let ready = settle(&restored, draft.id).await;
        assert_eq!(ready.status, ThreadStatus::SessionReady);
        assert_eq!(ready.turns.len(), 1);
        restored.shutdown().await;
    }
}

#[tokio::test]
async fn restart_of_an_approval_wait_restores_only_metadata_without_replaying_the_decision() {
    let root = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "prompt-permission".into());
    let first = Threads::with_store(vec![agent.clone()], store.clone()).unwrap();
    let draft = first.create(root.path()).unwrap();
    first.connect(draft.id).unwrap();
    settle(&first, draft.id).await;
    first
        .send_message(draft.id, "Do not restart this operation".into())
        .unwrap();
    let mut stream = subscribe(&first, draft.id);
    let permission = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let next = stream.recv().await.unwrap();
            if next.status == ThreadStatus::WaitingForApproval {
                break next.permissions[0].id;
            }
        }
    })
    .await
    .unwrap();
    first.shutdown().await;
    let stopped = first.get(draft.id).unwrap();
    assert_eq!(stopped.turns[0].stop_reason.as_deref(), Some("cancelled"));
    assert!(stopped.permissions.is_empty());
    let restored = Threads::with_store(vec![agent], store).unwrap();
    let thread = restored.get(draft.id).unwrap();
    assert!(thread.interrupted);
    assert!(thread.permissions.is_empty());
    assert!(thread.turns.is_empty());
    assert!(restored
        .answer_permission(draft.id, permission, "arbitrary-allow".into())
        .is_err());
    restored.connect(draft.id).unwrap();
    let ready = settle(&restored, draft.id).await;
    assert_eq!(ready.status, ThreadStatus::SessionReady);
    assert!(ready.turns.is_empty());
    restored.shutdown().await;
    let reopened = Threads::with_store(
        vec![],
        std::sync::Arc::new(
            atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
        ),
    )
    .unwrap();
    assert!(reopened.get(draft.id).unwrap().interrupted);
}

#[tokio::test]
async fn missing_agent_keeps_the_session_reference_and_can_be_reinstalled_for_explicit_retry() {
    use atte_lib::thread::ConnectionFailure;
    let root = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let first = Threads::with_store(vec![mock_agent()], store.clone()).unwrap();
    let draft = first.create(root.path()).unwrap();
    first.connect(draft.id).unwrap();
    settle(&first, draft.id).await;
    first.shutdown().await;
    let restored = Threads::with_store(vec![], store).unwrap();
    assert!(restored.connect(draft.id).is_err());
    assert_eq!(
        restored.get(draft.id).unwrap().failure,
        Some(ConnectionFailure::AgentRemoved)
    );
    restored.register_agent(mock_agent()).unwrap();
    assert_eq!(restored.get(draft.id).unwrap().status, ThreadStatus::Failed);
    restored.connect(draft.id).unwrap();
    let ready = settle(&restored, draft.id).await;
    assert_eq!(ready.status, ThreadStatus::SessionReady);
    assert_eq!(ready.session_id.as_deref(), Some("remote-1"));
    restored.shutdown().await;
}

#[tokio::test]
async fn replay_keeps_distinct_message_ids_even_when_the_text_is_identical() {
    let root = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let first = Threads::with_store(vec![mock_agent()], store.clone()).unwrap();
    let draft = first.create(root.path()).unwrap();
    first.connect(draft.id).unwrap();
    settle(&first, draft.id).await;
    first.shutdown().await;
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "replay-chunks".into());
    let log = root.path().join("requests.log");
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let restored = Threads::with_store(vec![agent], store).unwrap();
    restored.connect(draft.id).unwrap();
    restored.connect(draft.id).unwrap();
    let loaded = settle(&restored, draft.id).await;
    assert_eq!(
        loaded
            .turns
            .iter()
            .map(|turn| turn.message.as_str())
            .collect::<Vec<_>>(),
        ["Same question", "Same question"]
    );
    assert_eq!(loaded.turns[1].response, "Answer");
    restored.shutdown().await;
    assert_eq!(
        std::fs::read_to_string(log).unwrap(),
        "initialize\nsession/load\n"
    );
}

#[tokio::test]
async fn replay_restores_resource_links_as_read_only_attachment_metadata() {
    let root = tempfile::tempdir().unwrap();
    let session_file = root.path().join("agent.json");
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let mut agent = mock_agent();
    agent
        .env
        .insert("SESSION_FILE".into(), session_file.to_string_lossy().into());
    let first = Threads::with_store(vec![agent.clone()], store.clone()).unwrap();
    let draft = first.create(root.path()).unwrap();
    first.connect(draft.id).unwrap();
    settle(&first, draft.id).await;
    first
        .send_input(
            draft.id,
            UserInput {
                body: "Review".into(),
                attachments: vec![Attachment::file(
                    uuid::Uuid::new_v4(),
                    "report.pdf",
                    "file:///tmp/report.pdf",
                )],
            },
        )
        .unwrap();
    settle(&first, draft.id).await;
    first.shutdown().await;

    let restored = Threads::with_store(vec![agent], store).unwrap();
    restored.connect(draft.id).unwrap();
    let loaded = settle(&restored, draft.id).await;

    assert_eq!(
        (
            loaded.turns[0].message.as_str(),
            loaded.turns[0].attachments[0].name.as_str(),
            loaded.turns[0].attachments[0].uri.as_deref(),
        ),
        ("Review", "report.pdf", Some("file:///tmp/report.pdf"))
    );
    restored.shutdown().await;
}

#[tokio::test]
#[ignore = "requires ATTE_CODEX_ACP pointing to the installed Codex adapter and its existing login"]
async fn real_codex_restores_history_and_context_after_process_and_core_restart() {
    let root = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let marker = format!("ATTE-06-{}", uuid::Uuid::new_v4());
    let first =
        Threads::with_store(vec![atte_lib::agent::prepared_codex()], store.clone()).unwrap();
    let draft = first.create(root.path()).unwrap();
    first.connect(draft.id).unwrap();
    let connected = settle(&first, draft.id).await;
    assert_eq!(
        connected.status,
        ThreadStatus::SessionReady,
        "{connected:?}"
    );
    first.send_message(draft.id, format!("Do not use tools or access any files. Remember this marker for our thread: {marker}. Reply with only this marker.")).unwrap();
    let original = tokio::time::timeout(Duration::from_secs(120), async {
        let mut updates = subscribe(&first, draft.id);
        loop {
            let thread = updates.recv().await.unwrap();
            if thread.status == ThreadStatus::SessionReady || thread.status == ThreadStatus::Failed
            {
                break thread;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(original.status, ThreadStatus::SessionReady, "{original:?}");
    assert!(original.turns[0].response.contains(&marker));
    first.shutdown().await;
    drop(first);
    let restored = Threads::with_store(vec![atte_lib::agent::prepared_codex()], store).unwrap();
    assert!(restored.get(draft.id).unwrap().turns.is_empty());
    restored.connect(draft.id).unwrap();
    let loaded = settle(&restored, draft.id).await;
    assert_eq!(loaded.status, ThreadStatus::SessionReady, "{loaded:?}");
    assert_eq!(loaded.session_id, original.session_id);
    assert!(loaded
        .turns
        .iter()
        .any(|turn| turn.response.contains(&marker)));
    restored.send_message(draft.id, "Without tools or file access, what marker did I ask you to remember? Reply with the marker only.".into()).unwrap();
    let answer = tokio::time::timeout(Duration::from_secs(120), async {
        let mut updates = subscribe(&restored, draft.id);
        loop {
            let thread = updates.recv().await.unwrap();
            if thread.status == ThreadStatus::SessionReady || thread.status == ThreadStatus::Failed
            {
                break thread;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(answer.status, ThreadStatus::SessionReady, "{answer:?}");
    assert!(answer.turns.last().unwrap().response.contains(&marker));
    restored.shutdown().await;
}

#[tokio::test]
async fn cancels_only_the_active_turn_and_continues_the_same_session() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "cancel".into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let mut stream = subscribe(&threads, draft.id);
    threads.send_message(draft.id, "start".into()).unwrap();
    let active = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = stream.recv().await.unwrap();
            if thread
                .turns
                .last()
                .is_some_and(|turn| turn.response == "Started")
            {
                break thread;
            }
        }
    })
    .await
    .unwrap();
    let turn = active.turns[0].id;
    threads.cancel_turn(draft.id, turn).unwrap();
    threads.cancel_turn(draft.id, turn).unwrap();
    let cancelled = settle(&threads, draft.id).await;
    assert_eq!(cancelled.status, ThreadStatus::SessionReady);
    assert_eq!(cancelled.turns[0].stop_reason.as_deref(), Some("cancelled"));
    assert_eq!(cancelled.turns[0].response, "Started");
    assert!(cancelled.interrupted);
    threads.send_message(draft.id, "continue".into()).unwrap();
    assert!(threads.cancel_turn(draft.id, turn).is_err());
    let completed = settle(&threads, draft.id).await;
    assert_eq!(completed.session_id, active.session_id);
    assert_eq!(completed.turns.len(), 2);
    assert_eq!(completed.turns[1].response, "Hello world");
    threads.shutdown().await;
}

#[tokio::test]
async fn connects_a_draft_without_replacing_its_identity_or_duplicating_sessions() {
    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![mock_agent()]);
    let draft = threads.create_for_agent(folder.path(), "fixture").unwrap();
    assert_eq!(
        threads.connect(draft.id).unwrap().status,
        ThreadStatus::Connecting
    );
    threads.connect(draft.id).unwrap();
    let connected = settle(&threads, draft.id).await;
    assert_eq!(connected.status, ThreadStatus::SessionReady);
    assert_eq!(connected.session_id.as_deref(), Some("remote-1"));
    assert_eq!(connected.id, draft.id);
    assert_eq!(threads.connect(draft.id).unwrap(), connected);
    threads.shutdown().await;
}

#[tokio::test]
async fn thread_configuration_round_trips_opaque_typed_agent_values() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("CONFIGURATION".into(), "1".into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();

    let connected = settle(&threads, draft.id).await;
    assert_eq!(connected.configuration.len(), 3);
    assert_eq!(connected.configuration[0].id, "opaque-model");
    assert_eq!(
        connected.configuration[1].category.as_deref(),
        Some("thought_level")
    );
    assert_eq!(
        connected.configuration[2].category.as_deref(),
        Some("future_category")
    );

    threads
        .set_configuration(
            draft.id,
            "opaque-thinking".into(),
            ThreadConfigurationValue::Boolean { value: false },
        )
        .await
        .unwrap();
    let updated = threads.get(draft.id).unwrap();
    assert_eq!(
        serde_json::to_value(&updated.configuration[2]).unwrap()["currentValue"],
        false
    );
    assert_eq!(updated.status, ThreadStatus::SessionReady);
    threads.shutdown().await;
}

#[tokio::test]
async fn configuration_selection_is_published_before_the_request_completes() {
    let folder = tempfile::tempdir().unwrap();
    let requests = folder.path().join("configuration-requests.jsonl");
    let gate = folder.path().join("configuration-gate");
    let mut agent = mock_agent();
    agent.env.insert("CONFIGURATION".into(), "1".into());
    add_configuration_gate(&mut agent, &gate);
    agent.env.insert(
        "CONFIGURATION_REQUEST_LOG".into(),
        requests.to_string_lossy().into(),
    );
    let threads = std::sync::Arc::new(Threads::new(vec![agent]));
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let mut updates = subscribe(&threads, draft.id);

    let changing = {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .set_configuration(
                    draft.id,
                    "opaque-thinking".into(),
                    ThreadConfigurationValue::Boolean { value: false },
                )
                .await
        })
    };
    wait_for_configuration_gate(&gate, 1, "request").await;
    let optimistic = tokio::time::timeout(Duration::from_millis(100), async {
        loop {
            let thread = updates.recv().await.unwrap();
            if serde_json::to_value(&thread.configuration[2]).unwrap()["currentValue"] == false {
                break thread;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(optimistic.status, ThreadStatus::SessionReady);
    assert!(!changing.is_finished());
    release_configuration_gate(&gate, 1, "request");
    changing.await.unwrap().unwrap();

    assert_eq!(
        std::fs::read_to_string(requests).unwrap().lines().count(),
        1
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn selecting_the_displayed_configuration_value_sends_no_request() {
    let folder = tempfile::tempdir().unwrap();
    let requests = folder.path().join("configuration-requests.jsonl");
    let mut agent = mock_agent();
    agent.env.insert("CONFIGURATION".into(), "1".into());
    agent.env.insert(
        "CONFIGURATION_REQUEST_LOG".into(),
        requests.to_string_lossy().into(),
    );
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;

    threads
        .set_configuration(
            draft.id,
            "opaque-thinking".into(),
            ThreadConfigurationValue::Boolean { value: true },
        )
        .await
        .unwrap();

    assert!(std::fs::read_to_string(requests)
        .unwrap_or_default()
        .is_empty());
    threads.shutdown().await;
}

#[tokio::test]
async fn unsent_configuration_selections_coalesce_to_the_latest_displayed_value() {
    let folder = tempfile::tempdir().unwrap();
    let requests = folder.path().join("configuration-requests.jsonl");
    let gate = folder.path().join("configuration-gate");
    let mut agent = mock_agent();
    agent.env.insert("CONFIGURATION".into(), "1".into());
    add_configuration_gate(&mut agent, &gate);
    agent.env.insert(
        "CONFIGURATION_REQUEST_LOG".into(),
        requests.to_string_lossy().into(),
    );
    let threads = std::sync::Arc::new(Threads::new(vec![agent]));
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;

    let select = |value| {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .set_configuration(
                    draft.id,
                    "opaque-thinking".into(),
                    ThreadConfigurationValue::Boolean { value },
                )
                .await
        })
    };
    let first = select(false);
    wait_for_configuration_gate(&gate, 1, "request").await;
    let superseded = select(true);
    wait_for_boolean_configuration(&threads, draft.id, "opaque-thinking", true).await;
    let latest = select(false);
    wait_for_boolean_configuration(&threads, draft.id, "opaque-thinking", false).await;
    release_configuration_gate(&gate, 1, "request");

    first.await.unwrap().unwrap();
    superseded.await.unwrap().unwrap();
    latest.await.unwrap().unwrap();
    assert_eq!(
        std::fs::read_to_string(requests).unwrap().lines().count(),
        1
    );
    assert_eq!(
        serde_json::to_value(&threads.get(draft.id).unwrap().configuration[2]).unwrap()
            ["currentValue"],
        false
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn configuration_responses_revalidate_dependent_unsent_selections() {
    let folder = tempfile::tempdir().unwrap();
    let requests = folder.path().join("configuration-requests.jsonl");
    let gate = folder.path().join("configuration-gate");
    let mut agent = mock_agent();
    for (key, value) in [("CONFIGURATION", "1"), ("RESPONSIVE_CONFIGURATION", "1")] {
        agent.env.insert(key.into(), value.into());
    }
    add_configuration_gate(&mut agent, &gate);
    agent.env.insert(
        "CONFIGURATION_REQUEST_LOG".into(),
        requests.to_string_lossy().into(),
    );
    let threads = std::sync::Arc::new(Threads::new(vec![agent]));
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;

    let model = {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .set_configuration(
                    draft.id,
                    "opaque-model".into(),
                    ThreadConfigurationValue::Select {
                        value: "model-b".into(),
                    },
                )
                .await
        })
    };
    wait_for_configuration_gate(&gate, 1, "request").await;
    let effort = {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .set_configuration(
                    draft.id,
                    "opaque-effort".into(),
                    ThreadConfigurationValue::Select {
                        value: "high".into(),
                    },
                )
                .await
        })
    };
    wait_for_select_configuration(&threads, draft.id, "opaque-effort", "high").await;
    release_configuration_gate(&gate, 1, "request");

    model.await.unwrap().unwrap();
    effort.await.unwrap().unwrap();
    assert_eq!(
        std::fs::read_to_string(requests).unwrap().lines().count(),
        1
    );
    let configuration = threads.get(draft.id).unwrap().configuration;
    assert_eq!(
        serde_json::to_value(&configuration[0]).unwrap()["currentValue"],
        "model-b"
    );
    assert_eq!(
        serde_json::to_value(&configuration[1]).unwrap()["currentValue"],
        "low"
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn configuration_changes_preserve_order_across_different_settings() {
    let folder = tempfile::tempdir().unwrap();
    let requests = folder.path().join("configuration-requests.jsonl");
    let gate = folder.path().join("configuration-gate");
    let mut agent = mock_agent();
    for (key, value) in [("CONFIGURATION", "1"), ("RESPONSIVE_CONFIGURATION", "1")] {
        agent.env.insert(key.into(), value.into());
    }
    add_configuration_gate(&mut agent, &gate);
    agent.env.insert(
        "CONFIGURATION_REQUEST_LOG".into(),
        requests.to_string_lossy().into(),
    );
    let threads = std::sync::Arc::new(Threads::new(vec![agent]));
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;

    let thinking = {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .set_configuration(
                    draft.id,
                    "opaque-thinking".into(),
                    ThreadConfigurationValue::Boolean { value: false },
                )
                .await
        })
    };
    wait_for_configuration_gate(&gate, 1, "request").await;
    let model = {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .set_configuration(
                    draft.id,
                    "opaque-model".into(),
                    ThreadConfigurationValue::Select {
                        value: "model-b".into(),
                    },
                )
                .await
        })
    };
    wait_for_select_configuration(&threads, draft.id, "opaque-model", "model-b").await;
    assert!(!gate.join("2.request.arrived").exists());
    release_configuration_gate(&gate, 1, "request");
    wait_for_configuration_gate(&gate, 2, "request").await;
    release_configuration_gate(&gate, 2, "request");

    thinking.await.unwrap().unwrap();
    model.await.unwrap().unwrap();
    let ids: Vec<_> = std::fs::read_to_string(requests)
        .unwrap()
        .lines()
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["configId"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(ids, ["opaque-thinking", "opaque-model"]);
    threads.shutdown().await;
}

#[tokio::test]
async fn configuration_failure_rolls_back_without_interrupting_turn_or_queue() {
    let folder = tempfile::tempdir().unwrap();
    let requests = folder.path().join("configuration-requests.jsonl");
    let gate = folder.path().join("configuration-gate");
    let mut agent = mock_agent();
    for (key, value) in [
        ("CONFIGURATION", "1"),
        ("RESPONSIVE_CONFIGURATION", "1"),
        ("CONFIGURATION_FAIL_CONFIG", "opaque-thinking"),
        ("FIXTURE_MODE", "cancel"),
    ] {
        agent.env.insert(key.into(), value.into());
    }
    add_configuration_gate(&mut agent, &gate);
    agent.env.insert(
        "CONFIGURATION_REQUEST_LOG".into(),
        requests.to_string_lossy().into(),
    );
    let threads = std::sync::Arc::new(Threads::new(vec![agent]));
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;

    let changing = {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .set_configuration(
                    draft.id,
                    "opaque-thinking".into(),
                    ThreadConfigurationValue::Boolean { value: false },
                )
                .await
        })
    };
    wait_for_configuration_gate(&gate, 1, "request").await;
    threads.send_message(draft.id, "working".into()).unwrap();
    threads.send_message(draft.id, "queued".into()).unwrap();
    release_configuration_gate(&gate, 1, "request");

    assert!(changing.await.unwrap().is_err());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = threads.get(draft.id).unwrap();
            if thread.turns[0].response == "Started" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let running = threads.get(draft.id).unwrap();
    assert_eq!(running.status, ThreadStatus::Running);
    assert_eq!(running.queued_messages[0].input.body, "queued");
    assert_eq!(
        serde_json::to_value(&running.configuration[2]).unwrap()["currentValue"],
        true
    );
    threads.cancel_turn(draft.id, running.turns[0].id).unwrap();
    settle(&threads, draft.id).await;
    threads.shutdown().await;
}

#[tokio::test]
async fn agent_snapshot_during_configuration_keeps_the_latest_valid_selection_visible() {
    let folder = tempfile::tempdir().unwrap();
    let gate = folder.path().join("configuration-gate");
    let mut agent = mock_agent();
    for (key, value) in [
        ("CONFIGURATION", "1"),
        ("RESPONSIVE_CONFIGURATION", "1"),
        ("CONFIGURATION_UPDATE_WHILE_SET", "1"),
    ] {
        agent.env.insert(key.into(), value.into());
    }
    add_configuration_gate(&mut agent, &gate);
    let threads = std::sync::Arc::new(Threads::new(vec![agent]));
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let mut updates = subscribe(&threads, draft.id);

    let changing = {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .set_configuration(
                    draft.id,
                    "opaque-thinking".into(),
                    ThreadConfigurationValue::Boolean { value: false },
                )
                .await
        })
    };
    wait_for_configuration_gate(&gate, 1, "request").await;
    release_configuration_gate(&gate, 1, "request");
    wait_for_configuration_gate(&gate, 1, "update").await;
    let mut selected_snapshots = 0;
    tokio::time::timeout(Duration::from_secs(5), async {
        while selected_snapshots < 2 {
            if let Some(thread) = updates.recv().await {
                let value = serde_json::to_value(&thread.configuration[2]).unwrap()["currentValue"]
                    .as_bool();
                if selected_snapshots > 0 {
                    assert_eq!(value, Some(false));
                }
                if value == Some(false) {
                    selected_snapshots += 1;
                }
            }
        }
    })
    .await
    .unwrap();
    release_configuration_gate(&gate, 1, "update");
    changing.await.unwrap().unwrap();
    assert!(selected_snapshots >= 2);
    assert_eq!(
        serde_json::to_value(&threads.get(draft.id).unwrap().configuration[2]).unwrap()
            ["currentValue"],
        false
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn configuration_requests_for_different_threads_progress_independently() {
    let first_folder = tempfile::tempdir().unwrap();
    let second_folder = tempfile::tempdir().unwrap();
    let first_gate = first_folder.path().join("configuration-gate");
    let second_gate = second_folder.path().join("configuration-gate");
    let mut first_agent = mock_agent();
    first_agent.id = "fixture-first".into();
    first_agent.name = "Fixture first".into();
    first_agent.env.insert("CONFIGURATION".into(), "1".into());
    first_agent
        .env
        .insert("RESPONSIVE_CONFIGURATION".into(), "1".into());
    add_configuration_gate(&mut first_agent, &first_gate);
    let mut second_agent = mock_agent();
    second_agent.id = "fixture-second".into();
    second_agent.name = "Fixture second".into();
    second_agent.env.insert("CONFIGURATION".into(), "1".into());
    second_agent
        .env
        .insert("RESPONSIVE_CONFIGURATION".into(), "1".into());
    add_configuration_gate(&mut second_agent, &second_gate);
    let threads = std::sync::Arc::new(Threads::new(vec![first_agent, second_agent]));
    let first = threads
        .create_for_agent(first_folder.path(), "fixture-first")
        .unwrap();
    let second = threads
        .create_for_agent(second_folder.path(), "fixture-second")
        .unwrap();
    for id in [first.id, second.id] {
        threads.connect(id).unwrap();
        settle(&threads, id).await;
    }

    let select = |id| {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .set_configuration(
                    id,
                    "opaque-thinking".into(),
                    ThreadConfigurationValue::Boolean { value: false },
                )
                .await
        })
    };
    let first_change = select(first.id);
    let second_change = select(second.id);
    tokio::join!(
        wait_for_configuration_gate(&first_gate, 1, "request"),
        wait_for_configuration_gate(&second_gate, 1, "request")
    );
    assert!(!first_change.is_finished());
    assert!(!second_change.is_finished());
    release_configuration_gate(&first_gate, 1, "request");
    release_configuration_gate(&second_gate, 1, "request");
    first_change.await.unwrap().unwrap();
    second_change.await.unwrap().unwrap();
    threads.shutdown().await;
}

#[tokio::test]
async fn obsolete_configuration_result_cannot_overwrite_a_reconnected_thread() {
    let folder = tempfile::tempdir().unwrap();
    let gate = folder.path().join("configuration-gate");
    let mut agent = mock_agent();
    for (key, value) in [("CONFIGURATION", "1"), ("RESPONSIVE_CONFIGURATION", "1")] {
        agent.env.insert(key.into(), value.into());
    }
    add_configuration_gate(&mut agent, &gate);
    let replacement = agent.clone();
    let threads = std::sync::Arc::new(Threads::new(vec![agent]));
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;

    let changing = {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .set_configuration(
                    draft.id,
                    "opaque-thinking".into(),
                    ThreadConfigurationValue::Boolean { value: false },
                )
                .await
        })
    };
    wait_for_configuration_gate(&gate, 1, "request").await;
    assert!(threads
        .replace_agent_if_idle("fixture", || Ok(replacement))
        .await
        .unwrap());
    threads.connect(draft.id).unwrap();
    let reconnected = settle(&threads, draft.id).await;
    assert_eq!(
        serde_json::to_value(&reconnected.configuration[2]).unwrap()["currentValue"],
        true
    );
    let _ = changing.await;
    assert_eq!(
        serde_json::to_value(&threads.get(draft.id).unwrap().configuration[2]).unwrap()
            ["currentValue"],
        true
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn load_and_resume_restore_agent_configuration_without_local_defaults() {
    for mode in ["ready", "resume-only"] {
        let folder = tempfile::tempdir().unwrap();
        let mut initial_agent = mock_agent();
        initial_agent.env.insert("CONFIGURATION".into(), "1".into());
        let (store, id) = persist_remote_session(folder.path(), &initial_agent).await;
        let mut restoring_agent = mock_agent();
        restoring_agent
            .env
            .insert("CONFIGURATION".into(), "1".into());
        restoring_agent
            .env
            .insert("FIXTURE_MODE".into(), mode.into());
        let restored = Threads::with_store(vec![restoring_agent], store).unwrap();

        assert!(restored.get(id).unwrap().configuration.is_empty());
        restored.connect(id).unwrap();
        let connected = settle(&restored, id).await;
        assert_eq!(connected.configuration.len(), 3, "restore mode: {mode}");
        assert_eq!(connected.configuration[0].id, "opaque-model");
        restored.shutdown().await;
    }
}

#[tokio::test]
async fn agent_configuration_updates_apply_while_idle_and_running() {
    for update in [
        "CONFIGURATION_UPDATE_AFTER_SET",
        "CONFIGURATION_UPDATE_DURING_PROMPT",
    ] {
        let folder = tempfile::tempdir().unwrap();
        let mut agent = mock_agent();
        agent.env.insert("CONFIGURATION".into(), "1".into());
        agent.env.insert(update.into(), "1".into());
        let threads = Threads::new(vec![agent]);
        let draft = threads.create(folder.path()).unwrap();
        threads.connect(draft.id).unwrap();
        settle(&threads, draft.id).await;

        if update == "CONFIGURATION_UPDATE_AFTER_SET" {
            threads
                .set_configuration(
                    draft.id,
                    "opaque-thinking".into(),
                    ThreadConfigurationValue::Boolean { value: false },
                )
                .await
                .unwrap();
        } else {
            threads.send_message(draft.id, "update".into()).unwrap();
        }

        let expected = update == "CONFIGURATION_UPDATE_AFTER_SET";
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let thread = threads.get(draft.id).unwrap();
                let value = serde_json::to_value(&thread.configuration[2]).unwrap()["currentValue"]
                    .as_bool();
                if value == Some(expected) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        threads.shutdown().await;
    }
}

#[tokio::test]
async fn agent_configuration_updates_are_isolated_by_remote_session() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("CONFIGURATION".into(), "1".into());
    agent
        .env
        .insert("CONFIGURATION_UPDATE_OTHER".into(), "1".into());
    let threads = Threads::new(vec![agent]);
    let first = threads.create(folder.path()).unwrap();
    let second = threads.create(folder.path()).unwrap();
    threads.connect(first.id).unwrap();
    settle(&threads, first.id).await;
    threads.connect(second.id).unwrap();
    settle(&threads, second.id).await;

    threads
        .set_configuration(
            first.id,
            "opaque-thinking".into(),
            ThreadConfigurationValue::Boolean { value: false },
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let configuration = &threads.get(second.id).unwrap().configuration;
            let value = serde_json::to_value(&configuration[2]).unwrap()["currentValue"].as_bool();
            if value == Some(false) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(&threads.get(first.id).unwrap().configuration[2]).unwrap()
            ["currentValue"],
        true
    );
    threads.shutdown().await;
}

async fn settle(threads: &Threads, id: uuid::Uuid) -> atte_lib::thread::Thread {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = threads.get(id).unwrap();
            if !matches!(
                thread.status,
                ThreadStatus::Connecting
                    | ThreadStatus::Running
                    | ThreadStatus::WaitingForApproval
                    | ThreadStatus::Cancelling
            ) {
                return thread;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

async fn wait_for_request(log: &std::path::Path, expected: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !std::fs::read_to_string(log)
            .unwrap_or_default()
            .contains(expected)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn distinguishes_connection_failures_and_keeps_the_draft_for_explicit_retry() {
    use atte_lib::thread::{AuthenticationStatus, ConnectionFailure};
    for (mode, expected) in [
        ("init-error", ConnectionFailure::InitializationFailed),
        ("wrong-version", ConnectionFailure::InitializationFailed),
        ("session-error", ConnectionFailure::SessionCreationFailed),
        ("auth", ConnectionFailure::AuthenticationRequired),
        ("exit-init", ConnectionFailure::ProcessExited),
        ("missing", ConnectionFailure::ExecutableNotFound),
    ] {
        let folder = tempfile::tempdir().unwrap();
        let mut agent = mock_agent();
        agent.env.insert("FIXTURE_MODE".into(), mode.into());
        if mode == "missing" {
            agent.command = folder.path().join("missing-agent");
        }
        let threads = Threads::new(vec![agent]);
        let draft = threads.create_for_agent(folder.path(), "fixture").unwrap();
        for _ in 0..2 {
            threads.connect(draft.id).unwrap();
            let failed = settle(&threads, draft.id).await;
            assert_eq!(failed.status, ThreadStatus::Failed, "{mode}");
            assert_eq!(failed.failure, Some(expected.clone()), "{mode}");
            assert_eq!(failed.session_id, None);
            assert_eq!(
                failed.authentication,
                if mode == "auth" {
                    AuthenticationStatus::Required
                } else {
                    AuthenticationStatus::Unknown
                }
            );
        }
        threads.shutdown().await;
    }
}

#[tokio::test]
async fn unexpected_permission_requests_are_cancelled_without_blocking_setup() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "permission".into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create_for_agent(folder.path(), "fixture").unwrap();
    threads.connect(draft.id).unwrap();
    assert_eq!(
        settle(&threads, draft.id).await.status,
        ThreadStatus::SessionReady
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn process_exit_after_session_creation_is_observable() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "exit-ready".into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create_for_agent(folder.path(), "fixture").unwrap();
    threads.connect(draft.id).unwrap();
    assert_eq!(
        settle(&threads, draft.id).await.status,
        ThreadStatus::SessionReady
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = threads.get(draft.id).unwrap();
            if thread.status == ThreadStatus::Failed {
                assert_eq!(
                    thread.failure,
                    Some(atte_lib::thread::ConnectionFailure::ProcessExited)
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    threads.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_reaps_the_adapter_and_stops_its_descendants() {
    use nix::{sys::signal::kill, unistd::Pid};
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    let pid_file = folder.path().join("pid");
    let child_pid_file = folder.path().join("child-pid");
    agent.env.insert("FIXTURE_MODE".into(), "tree".into());
    agent
        .env
        .insert("PID_FILE".into(), pid_file.to_string_lossy().into());
    agent.env.insert(
        "CHILD_PID_FILE".into(),
        child_pid_file.to_string_lossy().into(),
    );
    let threads = Threads::new(vec![agent]);
    let draft = threads.create_for_agent(folder.path(), "fixture").unwrap();
    threads.connect(draft.id).unwrap();
    assert_eq!(
        settle(&threads, draft.id).await.status,
        ThreadStatus::SessionReady
    );
    let pid = Pid::from_raw(std::fs::read_to_string(pid_file).unwrap().parse().unwrap());
    let child_pid = Pid::from_raw(
        std::fs::read_to_string(child_pid_file)
            .unwrap()
            .parse()
            .unwrap(),
    );
    threads.shutdown().await;
    assert_eq!(
        threads.get(draft.id).unwrap().status,
        ThreadStatus::Disconnected
    );
    assert!(threads.connect(draft.id).is_err());
    tokio::time::timeout(Duration::from_secs(5), async {
        while kill(pid, None).is_ok() || kill(child_pid, None).is_ok() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn shutdown_reaps_descendants_that_create_their_own_process_group() {
    use nix::{sys::signal::kill, unistd::Pid};
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    let pid_file = folder.path().join("child-pid");
    agent.env.insert("FIXTURE_MODE".into(), "tree".into());
    agent.env.insert("DETACHED_CHILD".into(), "1".into());
    agent
        .env
        .insert("CHILD_PID_FILE".into(), pid_file.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    assert_eq!(
        settle(&threads, draft.id).await.status,
        ThreadStatus::SessionReady
    );
    let pid = Pid::from_raw(std::fs::read_to_string(pid_file).unwrap().parse().unwrap());
    threads.shutdown().await;
    let stopped = tokio::time::timeout(Duration::from_secs(3), async {
        while kill(pid, None).is_ok() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    if !stopped {
        let _ = kill(pid, nix::sys::signal::Signal::SIGKILL);
    }
    assert!(
        stopped,
        "an agent descendant in another process group survived quit"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn failed_setup_reaps_the_agent_before_retry_is_available() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    let pid_file = folder.path().join("pid");
    agent
        .env
        .insert("FIXTURE_MODE".into(), "session-error".into());
    agent
        .env
        .insert("PID_FILE".into(), pid_file.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create_for_agent(folder.path(), "fixture").unwrap();
    threads.connect(draft.id).unwrap();
    assert_eq!(
        settle(&threads, draft.id).await.status,
        ThreadStatus::Failed
    );
    let pid = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
    assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err());
    threads.shutdown().await;
}

/// Opt in with ATTE_CODEX_ACP pointing at a prepared adapter executable.
#[tokio::test]
#[ignore = "requires the user's prepared Codex adapter and login"]
async fn real_codex_initializes_and_creates_a_session() {
    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::default();
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    let connected = tokio::time::timeout(Duration::from_secs(35), async {
        loop {
            let thread = threads.get(draft.id).unwrap();
            if !matches!(
                thread.status,
                ThreadStatus::Connecting | ThreadStatus::Running
            ) {
                break thread;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    threads.shutdown().await;
    assert_eq!(
        connected.status,
        ThreadStatus::SessionReady,
        "{connected:?}"
    );
    assert!(connected.session_id.is_some());
    assert_eq!(
        connected.authentication,
        atte_lib::thread::AuthenticationStatus::Unknown
    );
}

#[tokio::test]
async fn rejects_unknown_agents_and_connecting_unknown_threads() {
    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![mock_agent()]);
    assert!(threads
        .create_for_agent(folder.path(), "unprepared")
        .is_err());
    assert!(threads.connect(uuid::Uuid::new_v4()).is_err());
}

#[tokio::test]
async fn connecting_a_draft_revalidates_a_removed_working_folder() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("project");
    std::fs::create_dir(&folder).unwrap();
    let threads = Threads::new(vec![mock_agent()]);
    let draft = threads.create_for_agent(&folder, "fixture").unwrap();
    std::fs::remove_dir(&folder).unwrap();
    assert!(matches!(
        threads.connect(draft.id),
        Err(atte_lib::thread::ThreadError::InvalidWorkingFolder(_))
    ));
    assert_eq!(
        threads.get(draft.id).unwrap().status,
        ThreadStatus::Disconnected
    );
}

#[tokio::test]
async fn streams_ordered_turns_and_sends_followups_in_the_same_session() {
    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![mock_agent()]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let mut stream = subscribe(&threads, draft.id);
    let _initial = stream.recv().await.unwrap();
    threads.send_message(draft.id, "hello".into()).unwrap();
    let mut texts = Vec::new();
    loop {
        let next = tokio::time::timeout(Duration::from_secs(5), stream.recv())
            .await
            .unwrap()
            .unwrap();
        texts.push(next.turns[0].response.clone());
        if next.status == ThreadStatus::SessionReady {
            break;
        }
    }
    assert_eq!(texts, ["", "Hello", "Hello world", "Hello world"]);
    threads.send_message(draft.id, "again".into()).unwrap();
    loop {
        let next = tokio::time::timeout(Duration::from_secs(5), stream.recv())
            .await
            .unwrap()
            .unwrap();
        if next.status == ThreadStatus::SessionReady {
            assert_eq!(next.session_id.as_deref(), Some("remote-1"));
            assert_eq!(next.turns.len(), 2);
            assert_eq!(next.turns[1].response, "Hello world");
            assert_eq!(next.turns[1].stop_reason.as_deref(), Some("end_turn"));
            break;
        }
    }
    threads.shutdown().await;
}

#[tokio::test]
async fn publishes_only_the_new_turn_after_the_initial_snapshot() {
    use atte_lib::thread::{ThreadUpdate, TurnUpdate};

    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![mock_agent()]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let mut updates = threads.subscribe(draft.id).unwrap();
    assert!(matches!(
        updates.recv().await,
        Some(ThreadUpdate::Thread { .. })
    ));

    threads.send_message(draft.id, "hello".into()).unwrap();
    let Some(ThreadUpdate::Patch {
        thread: patch,
        turn_updates,
        ..
    }) = updates.recv().await
    else {
        panic!("new turns are published as lightweight patches");
    };
    assert_eq!(patch.metadata.id, draft.id);
    assert!(matches!(
        turn_updates.as_slice(),
        [TurnUpdate::Added { .. }]
    ));
    threads.shutdown().await;
}

#[tokio::test]
async fn resubscription_is_coherent_and_detaching_does_not_stop_a_turn() {
    let folder = tempfile::tempdir().unwrap();
    let gate = folder.path().join("continue");
    let mut agent = mock_agent();
    agent
        .env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    assert!(threads.send_message(draft.id, "  ".into()).is_err());
    threads.send_message(draft.id, "hello".into()).unwrap();
    let mut stream = subscribe(&threads, draft.id);
    let first = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let next = stream.recv().await.unwrap();
            if next.turns[0].response == "Hello" {
                break next;
            }
        }
    })
    .await
    .unwrap();
    drop(stream);
    let mut resumed = subscribe(&threads, draft.id);
    assert_eq!(resumed.recv().await.unwrap(), first);
    drop(resumed);
    std::fs::write(gate, "continue").unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = threads.get(draft.id).unwrap();
            if thread.status == ThreadStatus::SessionReady {
                break thread;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut resumed = subscribe(&threads, draft.id);
    assert_eq!(resumed.recv().await.unwrap(), completed);
    assert_eq!(completed.turns[0].response, "Hello world");
    threads.shutdown().await;
}

#[tokio::test]
async fn unsuccessful_turns_preserve_the_queue_without_dispatching() {
    for mode in [
        "refusal",
        "max_tokens",
        "max_turn_requests",
        "prompt-error",
        "prompt-auth",
        "prompt-exit",
    ] {
        let folder = tempfile::tempdir().unwrap();
        let gate = folder.path().join("continue");
        let mut agent = mock_agent();
        agent.env.insert("FIXTURE_MODE".into(), mode.into());
        agent
            .env
            .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
        let threads = Threads::new(vec![agent]);
        let draft = threads.create(folder.path()).unwrap();
        threads.connect(draft.id).unwrap();
        settle(&threads, draft.id).await;
        threads.send_message(draft.id, "first".into()).unwrap();
        threads.send_message(draft.id, "keep".into()).unwrap();
        std::fs::write(gate, "continue").unwrap();
        let finished = settle(&threads, draft.id).await;
        assert_eq!(finished.turns.len(), 1, "{mode}");
        assert_eq!(finished.queued_messages[0].input.body, "keep", "{mode}");
        threads.shutdown().await;
    }
}

#[tokio::test]
async fn prompt_failures_preserve_partial_output_and_reject_stale_updates() {
    use atte_lib::thread::ConnectionFailure;
    for (mode, failure) in [
        ("prompt-auth", ConnectionFailure::AuthenticationRequired),
        (
            "prompt-auth-exit",
            ConnectionFailure::AuthenticationRequired,
        ),
        ("prompt-error", ConnectionFailure::PromptFailed),
        ("prompt-exit", ConnectionFailure::ProcessExited),
    ] {
        let folder = tempfile::tempdir().unwrap();
        let mut agent = mock_agent();
        agent.env.insert(
            "SESSION_FILE".into(),
            folder
                .path()
                .join("agent-history.json")
                .to_string_lossy()
                .into(),
        );
        agent.env.insert("FIXTURE_MODE".into(), mode.into());
        let threads = Threads::new(vec![agent]);
        let draft = threads.create(folder.path()).unwrap();
        threads.connect(draft.id).unwrap();
        settle(&threads, draft.id).await;
        let mut stream = subscribe(&threads, draft.id);
        threads.send_message(draft.id, "hello".into()).unwrap();
        let failed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let next = stream.recv().await.unwrap();
                if next.status == ThreadStatus::Failed {
                    break next;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(failed.failure, Some(failure), "{mode}");
        assert_eq!(failed.turns[0].response, "Hello world");
        assert!(threads.send_message(draft.id, "retry".into()).is_err());
        threads.connect(draft.id).unwrap();
        let reconnected = settle(&threads, draft.id).await;
        assert_eq!(reconnected.status, ThreadStatus::SessionReady);
        assert_eq!(reconnected.turns[0].response, "Hello world");
        threads.shutdown().await;
    }
}

#[tokio::test]
async fn permission_preserves_agent_choices_and_answers_exactly_once() {
    for (mode, option) in [
        ("prompt-permission", "arbitrary-allow"),
        ("prompt-permission", "deny-927"),
        ("partial-permission", "arbitrary-allow"),
    ] {
        let folder = tempfile::tempdir().unwrap();
        let mut agent = mock_agent();
        agent.env.insert("FIXTURE_MODE".into(), mode.into());
        let threads = Threads::new(vec![agent]);
        let draft = threads.create(folder.path()).unwrap();
        threads.connect(draft.id).unwrap();
        settle(&threads, draft.id).await;
        let mut stream = subscribe(&threads, draft.id);
        threads.send_message(draft.id, "hello".into()).unwrap();
        let waiting = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let next = stream.recv().await.unwrap();
                if next.status == ThreadStatus::WaitingForApproval {
                    break next;
                }
            }
        })
        .await
        .unwrap();
        let permission = &waiting.permissions[0];
        assert_eq!(permission.title, "Write fixture.txt");
        assert!(permission.details.contains("fixture.txt"));
        assert_eq!(
            permission
                .options
                .iter()
                .map(|option| (option.id.as_str(), option.name.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("deny-927", "Do not write"),
                ("arbitrary-allow", "Write once")
            ]
        );
        assert!(threads
            .answer_permission(draft.id, permission.id, "unknown".into())
            .is_err());
        threads
            .answer_permission(draft.id, permission.id, option.into())
            .unwrap();
        assert!(threads
            .answer_permission(draft.id, permission.id, option.into())
            .is_err());
        let completed = settle(&threads, draft.id).await;
        assert!(completed.permissions.is_empty());
        assert_eq!(
            completed.turns[0].response,
            format!("selected:{option}Hello world")
        );
        threads.shutdown().await;
    }
}

#[tokio::test]
async fn process_exit_during_approval_clears_permissions_and_preserves_the_queue() {
    use atte_lib::thread::ConnectionFailure;
    use nix::{
        sys::signal::{kill, Signal},
        unistd::Pid,
    };
    let folder = tempfile::tempdir().unwrap();
    let pid_file = folder.path().join("pid");
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "prompt-permission".into());
    agent
        .env
        .insert("PID_FILE".into(), pid_file.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let mut stream = subscribe(&threads, draft.id);
    threads
        .send_message(draft.id, "ask permission".into())
        .unwrap();
    let waiting = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let next = stream.recv().await.unwrap();
            if next.status == ThreadStatus::WaitingForApproval {
                break next;
            }
        }
    })
    .await
    .unwrap();
    threads
        .send_message(draft.id, "keep for later".into())
        .unwrap();
    let pid = Pid::from_raw(std::fs::read_to_string(pid_file).unwrap().parse().unwrap());
    kill(pid, Signal::SIGKILL).unwrap();
    let failed = settle(&threads, draft.id).await;
    assert_eq!(failed.status, ThreadStatus::Failed);
    assert_eq!(failed.failure, Some(ConnectionFailure::ProcessExited));
    assert!(failed.interrupted);
    assert!(failed.permissions.is_empty());
    assert_eq!(failed.session_id, waiting.session_id);
    assert_eq!(failed.turns, waiting.turns);
    assert_eq!(failed.queued_messages.len(), 1);
    assert_eq!(failed.queued_messages[0].input.body, "keep for later");
    assert!(threads
        .answer_permission(
            draft.id,
            waiting.permissions[0].id,
            "arbitrary-allow".into()
        )
        .is_err());
    threads.shutdown().await;
}

#[tokio::test]
async fn cancelling_permission_resolves_pending_and_late_requests_without_execution() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "permission-cancel".into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let mut stream = subscribe(&threads, draft.id);
    threads
        .send_message(draft.id, "ask permission".into())
        .unwrap();
    let waiting = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let next = stream.recv().await.unwrap();
            if next.status == ThreadStatus::WaitingForApproval {
                break next;
            }
        }
    })
    .await
    .unwrap();
    threads.cancel_turn(draft.id, waiting.turns[0].id).unwrap();
    assert!(threads
        .answer_permission(
            draft.id,
            waiting.permissions[0].id,
            "arbitrary-allow".into()
        )
        .is_err());
    let cancelled = settle(&threads, draft.id).await;
    assert_eq!(cancelled.status, ThreadStatus::SessionReady);
    assert!(cancelled.permissions.is_empty());
    assert_eq!(cancelled.turns[0].stop_reason.as_deref(), Some("cancelled"));
    assert_eq!(cancelled.turns[0].response, "");
    threads.send_message(draft.id, "follow up".into()).unwrap();
    let completed = settle(&threads, draft.id).await;
    assert_eq!(completed.turns[1].response, "Hello world");
    assert_eq!(completed.session_id, waiting.session_id);
    threads.shutdown().await;
}

#[tokio::test]
#[ignore = "requires the user's prepared Codex adapter and login"]
async fn real_codex_streams_and_continues_without_file_changes() {
    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::default();
    let draft = threads.create(folder.path()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(120), async {
        let mut stream = subscribe(&threads, draft.id);
        threads.connect(draft.id).unwrap();
        loop {
            let next = stream.recv().await.unwrap();
            if next.status == ThreadStatus::Failed { return Err(format!("{next:?}")); }
            if next.status == ThreadStatus::SessionReady { break; }
        }
        let session = threads.get(draft.id).unwrap().session_id;
        for message in [
            "Do not use tools or read or modify any files. Remember the token cobalt-73 for this thread. Reply with exactly: Remembered cobalt-73.",
            "Do not use tools or read or modify any files. What token did I ask you to remember? Reply with the token only.",
        ] {
            threads.send_message(draft.id, message.into()).unwrap();
            let mut streamed = 0;
            loop {
                let next = stream.recv().await.unwrap();
                if next.status == ThreadStatus::Failed { return Err(format!("{next:?}")); }
                if let Some(turn) = next.turns.last() {
                    if next.status == ThreadStatus::Running && !turn.response.is_empty() { streamed += 1; }
                    if next.status == ThreadStatus::SessionReady {
                        assert_eq!(next.session_id, session);
                        assert_eq!(turn.stop_reason.as_deref(), Some("end_turn"));
                        assert!(turn.response.contains("cobalt-73"), "{}", turn.response);
                        assert!(streamed > 0);
                        println!("turn {}: {streamed} streamed chunks; response: {}", next.turns.len(), turn.response);
                        break;
                    }
                }
            }
        }
        assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 0);
        Ok::<_, String>(())
    }).await;
    threads.shutdown().await;
    result.unwrap().unwrap();
}

struct TranscriptSubscription {
    receiver: tokio::sync::mpsc::UnboundedReceiver<atte_lib::thread::ThreadUpdate>,
    thread: Option<atte_lib::thread::Thread>,
}

fn subscribe(threads: &Threads, id: uuid::Uuid) -> TranscriptSubscription {
    TranscriptSubscription {
        receiver: threads.subscribe(id).unwrap(),
        thread: None,
    }
}

impl TranscriptSubscription {
    async fn recv(&mut self) -> Option<atte_lib::thread::Thread> {
        use atte_lib::thread::ThreadUpdate;
        match self.receiver.recv().await? {
            ThreadUpdate::Thread { thread } => self.thread = Some(*thread),
            ThreadUpdate::Patch {
                thread: patch,
                turn_updates,
                ..
            } => {
                use atte_lib::thread::TurnUpdate;
                let thread = self
                    .thread
                    .as_mut()
                    .expect("initial thread precedes patches");
                assert!(patch.apply_to(thread));
                for update in turn_updates {
                    match update {
                        TurnUpdate::Added { turn } => thread.turns.push(turn),
                        TurnUpdate::Completed {
                            turn_id,
                            stop_reason,
                        } => {
                            let turn = thread
                                .turns
                                .iter_mut()
                                .find(|turn| turn.id == turn_id)
                                .expect("completed turn exists");
                            turn.stop_reason = stop_reason;
                        }
                        TurnUpdate::Replaced { turns } => thread.turns = turns,
                    }
                }
            }
            ThreadUpdate::TextDelta {
                thread_id,
                turn_id,
                text,
            } => {
                let thread = self
                    .thread
                    .as_mut()
                    .expect("initial thread precedes deltas");
                assert_eq!(thread_id, thread.id);
                let turn = thread.turns.last_mut().unwrap();
                assert_eq!(turn_id, turn.id);
                turn.response.push_str(&text);
            }
        }
        self.thread.clone()
    }
}

#[tokio::test]
async fn preserves_authentication_error_when_process_exit_races_with_buffered_output() {
    use atte_lib::thread::{AuthenticationStatus, ConnectionFailure};
    let folder = tempfile::tempdir().unwrap();
    let gate = folder.path().join("continue");
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "prompt-auth-exit".into());
    agent
        .env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let mut stream = subscribe(&threads, draft.id);
    threads.send_message(draft.id, "hello".into()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let next = stream.recv().await.unwrap();
            if next
                .turns
                .last()
                .is_some_and(|turn| turn.response == "Hello")
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    std::fs::write(gate, "continue").unwrap();
    // Hold this single-threaded executor while the peer writes its result and exits.
    // On the next poll both process exit and buffered protocol data are available.
    std::thread::sleep(Duration::from_millis(100));
    let failed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let next = stream.recv().await.unwrap();
            if next.status == ThreadStatus::Failed {
                break next;
            }
        }
    })
    .await
    .unwrap();
    threads.shutdown().await;
    assert_eq!(
        failed.failure,
        Some(ConnectionFailure::AuthenticationRequired)
    );
    assert_eq!(failed.authentication, AuthenticationStatus::Required);
    assert_eq!(failed.turns[0].response, "Hello world");
}

#[tokio::test]
async fn installing_an_agent_preserves_the_existing_connection_and_subscription() {
    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![mock_agent()]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let mut updates = threads.subscribe(draft.id).unwrap();
    updates.recv().await.unwrap();
    let mut installed = mock_agent();
    installed.id = "installed".into();
    threads.register_agent(installed).unwrap();
    assert_eq!(threads.prepared_agents().len(), 2);
    threads.send_message(draft.id, "hello".into()).unwrap();
    let ready = settle(&threads, draft.id).await;
    assert_eq!(ready.agent_id, "fixture");
    assert_eq!(ready.turns[0].response, "Hello world");
    assert!(updates.recv().await.is_some());
    threads.shutdown().await;
}

#[tokio::test]
async fn all_targets_authenticate_then_retry_the_same_thread_after_expiry() {
    use atte_lib::agent_management::authentication::inspect;
    use atte_lib::thread::{AuthenticationStatus, ConnectionFailure};
    for id in ["claude", "codex", "antigravity"] {
        let root = tempfile::tempdir().unwrap();
        let login = root.path().join("login");
        let mut agent = mock_agent();
        agent.env.insert(
            "SESSION_FILE".into(),
            root.path()
                .join("agent-history.json")
                .to_string_lossy()
                .into(),
        );
        agent.id = id.into();
        agent
            .env
            .insert("AUTH_FILE".into(), login.to_string_lossy().into_owned());
        let before = inspect(&agent, root.path(), None).await.unwrap();
        assert!(before.connected);
        assert!(!before.authenticated);
        assert_eq!(before.methods[0].id, "fixture-login");
        assert!(inspect(&agent, root.path(), Some("invented"))
            .await
            .is_err());
        assert!(inspect(&agent, root.path(), Some("fixture-denied"))
            .await
            .is_err());
        let threads = Threads::new(vec![agent.clone()]);
        let draft = threads.create(root.path()).unwrap();
        threads.connect(draft.id).unwrap();
        assert_eq!(
            settle(&threads, draft.id).await.failure,
            Some(ConnectionFailure::AuthenticationRequired)
        );
        assert!(
            inspect(&agent, root.path(), Some("fixture-login"))
                .await
                .unwrap()
                .authenticated
        );
        threads.connect(draft.id).unwrap();
        settle(&threads, draft.id).await;
        threads.send_message(draft.id, "hello".into()).unwrap();
        assert_eq!(
            settle(&threads, draft.id).await.authentication,
            AuthenticationStatus::Authenticated
        );
        std::fs::remove_file(&login).unwrap();
        threads.send_message(draft.id, "expired".into()).unwrap();
        assert_eq!(
            settle(&threads, draft.id).await.authentication,
            AuthenticationStatus::Required
        );
        inspect(&agent, root.path(), Some("fixture-login"))
            .await
            .unwrap();
        threads.connect(draft.id).unwrap();
        settle(&threads, draft.id).await;
        threads.send_message(draft.id, "retry".into()).unwrap();
        let ready = settle(&threads, draft.id).await;
        assert_eq!(ready.id, draft.id);
        assert_eq!(ready.agent_id, id);
        assert_eq!(ready.turns.len(), 3);
        threads.shutdown().await;
    }
}

#[tokio::test]
async fn replacing_a_definition_preserves_live_connections_and_applies_to_new_connections() {
    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![mock_agent()]);
    let original = threads.create(folder.path()).unwrap();
    threads.connect(original.id).unwrap();
    settle(&threads, original.id).await;
    let mut replacement = mock_agent();
    replacement.command = folder.path().join("missing-agent");
    threads.register_agent(replacement).unwrap();
    threads.connect(original.id).unwrap();
    assert_eq!(
        settle(&threads, original.id).await.status,
        ThreadStatus::SessionReady
    );
    let new = threads.create(folder.path()).unwrap();
    threads.connect(new.id).unwrap();
    assert_eq!(
        settle(&threads, new.id).await.failure,
        Some(atte_lib::thread::ConnectionFailure::ExecutableNotFound)
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn draining_an_agent_waits_for_every_active_turn() {
    let root = tempfile::tempdir().unwrap();
    let first_folder = root.path().join("first");
    let second_folder = root.path().join("second");
    std::fs::create_dir_all(&first_folder).unwrap();
    std::fs::create_dir_all(&second_folder).unwrap();
    let gate = root.path().join("release-old-turns");
    let mut old = mock_agent();
    old.env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    let threads = std::sync::Arc::new(Threads::new(vec![old]));
    let first = threads.create(&first_folder).unwrap();
    let second = threads.create(&second_folder).unwrap();
    for id in [first.id, second.id] {
        threads.connect(id).unwrap();
        settle(&threads, id).await;
        threads.send_message(id, format!("old-{id}")).unwrap();
        let mut updates = subscribe(&threads, id);
        tokio::time::timeout(Duration::from_secs(5), async {
            while updates
                .recv()
                .await
                .unwrap()
                .turns
                .last()
                .is_none_or(|turn| turn.response != "Hello")
            {}
        })
        .await
        .unwrap();
    }

    let transition = {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .drain_and_replace_agent("fixture", || Ok(mock_agent()))
                .await
        })
    };
    tokio::task::yield_now().await;
    assert!(!transition.is_finished());

    std::fs::write(&gate, "continue").unwrap();
    transition.await.unwrap().unwrap();
    threads.shutdown().await;
}

#[tokio::test]
async fn draining_dispatches_a_preserved_message_only_on_the_replacement() {
    let root = tempfile::tempdir().unwrap();
    let gate = root.path().join("release-old-turn");
    let old_log = root.path().join("old.log");
    let new_log = root.path().join("new.log");
    let mut old = mock_agent();
    old.env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    old.env
        .insert("REQUEST_LOG".into(), old_log.to_string_lossy().into());
    let threads = std::sync::Arc::new(Threads::new(vec![old]));
    let draft = threads.create(root.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads.send_message(draft.id, "old".into()).unwrap();
    let mut updates = subscribe(&threads, draft.id);
    tokio::time::timeout(Duration::from_secs(5), async {
        while updates
            .recv()
            .await
            .unwrap()
            .turns
            .last()
            .is_none_or(|turn| turn.response != "Hello")
        {}
    })
    .await
    .unwrap();
    let transition = {
        let threads = threads.clone();
        let new_log = new_log.clone();
        tokio::spawn(async move {
            threads
                .drain_and_replace_agent("fixture", || {
                    let mut replacement = mock_agent();
                    replacement
                        .env
                        .insert("REQUEST_LOG".into(), new_log.to_string_lossy().into());
                    Ok(replacement)
                })
                .await
        })
    };
    tokio::task::yield_now().await;
    threads.send_message(draft.id, "preserved".into()).unwrap();
    std::fs::write(gate, "continue").unwrap();
    transition.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !threads.get(draft.id).unwrap().queued_messages.is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    assert_eq!(
        (
            std::fs::read_to_string(old_log)
                .unwrap()
                .matches("session/prompt")
                .count(),
            std::fs::read_to_string(new_log)
                .unwrap()
                .matches("session/prompt")
                .count(),
        ),
        (1, 1)
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn shutdown_cancels_a_transition_without_waiting_for_the_active_turn() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    let threads = std::sync::Arc::new(Threads::new(vec![agent]));
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads.send_message(draft.id, "hold".into()).unwrap();
    let transition = {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .drain_and_replace_agent("fixture", || Ok(mock_agent()))
                .await
        })
    };
    tokio::task::yield_now().await;

    tokio::time::timeout(Duration::from_secs(3), threads.shutdown())
        .await
        .unwrap();
    assert!(transition.await.unwrap().is_err());
}

#[tokio::test]
async fn a_new_connection_cannot_start_on_the_old_definition_during_promotion() {
    let root = tempfile::tempdir().unwrap();
    let active_folder = root.path().join("active");
    let waiting_folder = root.path().join("waiting");
    std::fs::create_dir_all(&active_folder).unwrap();
    std::fs::create_dir_all(&waiting_folder).unwrap();
    let gate = root.path().join("release");
    let old_log = root.path().join("old.log");
    let new_log = root.path().join("new.log");
    let mut old = mock_agent();
    old.env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    old.env
        .insert("REQUEST_LOG".into(), old_log.to_string_lossy().into());
    let threads = std::sync::Arc::new(Threads::new(vec![old]));
    let active = threads.create(&active_folder).unwrap();
    let waiting = threads.create(&waiting_folder).unwrap();
    threads.connect(active.id).unwrap();
    settle(&threads, active.id).await;
    threads
        .send_message(active.id, "hold transition".into())
        .unwrap();
    let mut updates = subscribe(&threads, active.id);
    tokio::time::timeout(Duration::from_secs(5), async {
        while updates
            .recv()
            .await
            .unwrap()
            .turns
            .last()
            .is_none_or(|turn| turn.response != "Hello")
        {}
    })
    .await
    .unwrap();
    let transition = {
        let threads = threads.clone();
        let new_log = new_log.clone();
        tokio::spawn(async move {
            threads
                .drain_and_replace_agent("fixture", || {
                    let mut replacement = mock_agent();
                    replacement
                        .env
                        .insert("REQUEST_LOG".into(), new_log.to_string_lossy().into());
                    Ok(replacement)
                })
                .await
        })
    };
    tokio::task::yield_now().await;
    let blocked = threads.connect(waiting.id).is_err();
    std::fs::write(gate, "continue").unwrap();
    transition.await.unwrap().unwrap();
    threads.connect(waiting.id).unwrap();
    settle(&threads, waiting.id).await;

    assert_eq!(
        (
            blocked,
            std::fs::read_to_string(old_log)
                .unwrap()
                .matches("session/new")
                .count(),
            std::fs::read_to_string(new_log)
                .unwrap()
                .matches("session/new")
                .count(),
        ),
        (true, 1, 1)
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn draining_forces_only_the_owned_group_after_graceful_shutdown_times_out() {
    use nix::{sys::signal::kill, unistd::Pid};
    let folder = tempfile::tempdir().unwrap();
    let pid_file = folder.path().join("pid");
    let mut agent = mock_agent();
    agent.env.insert("DETACHED_CHILD".into(), "1".into());
    agent
        .env
        .insert("PID_FILE".into(), pid_file.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let pid = std::fs::read_to_string(pid_file)
        .unwrap()
        .parse::<i32>()
        .unwrap();
    let started = std::time::Instant::now();

    threads
        .drain_and_replace_agent("fixture", || Ok(mock_agent()))
        .await
        .unwrap();

    assert_eq!(
        (
            kill(Pid::from_raw(pid), None).is_err(),
            started.elapsed() >= Duration::from_millis(900),
            started.elapsed() < Duration::from_secs(3),
        ),
        (true, true, true)
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn a_failed_promotion_retry_resumes_the_preserved_queue() {
    let root = tempfile::tempdir().unwrap();
    let gate = root.path().join("release-old-turn");
    let new_log = root.path().join("new.log");
    let mut old = mock_agent();
    old.env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    let threads = std::sync::Arc::new(Threads::new(vec![old]));
    let draft = threads.create(root.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads.send_message(draft.id, "old turn".into()).unwrap();
    let mut updates = subscribe(&threads, draft.id);
    tokio::time::timeout(Duration::from_secs(5), async {
        while updates
            .recv()
            .await
            .unwrap()
            .turns
            .last()
            .is_none_or(|turn| turn.response != "Hello")
        {}
    })
    .await
    .unwrap();
    let first = {
        let threads = threads.clone();
        tokio::spawn(async move {
            threads
                .drain_and_replace_agent("fixture", || {
                    Err(atte_lib::thread::ThreadError::Unavailable(
                        "injected promotion failure".into(),
                    ))
                })
                .await
        })
    };
    tokio::task::yield_now().await;
    threads.send_message(draft.id, "preserved".into()).unwrap();
    std::fs::write(gate, "continue").unwrap();
    assert!(first.await.unwrap().is_err());

    threads
        .drain_and_replace_agent("fixture", || {
            let mut replacement = mock_agent();
            replacement
                .env
                .insert("REQUEST_LOG".into(), new_log.to_string_lossy().into());
            Ok(replacement)
        })
        .await
        .unwrap();
    let resumed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let thread = threads.get(draft.id).unwrap();
            if thread.queued_messages.is_empty() && thread.status == ThreadStatus::SessionReady {
                break thread;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    assert_eq!(
        (
            resumed.turns.last().map(|turn| turn.message.as_str()),
            std::fs::read_to_string(new_log)
                .unwrap()
                .matches("session/prompt")
                .count(),
        ),
        (Some("preserved"), 1)
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn management_observes_expiry_and_login_without_restarting_the_failed_thread() {
    use atte_lib::{
        agent_management::AgentManagement,
        storage::{Installation, Store},
    };
    let root = tempfile::tempdir().unwrap();
    let login = root.path().join("login");
    let mut agent = mock_agent();
    agent.id = "codex".into();
    agent
        .env
        .insert("AUTH_FILE".into(), login.to_string_lossy().into_owned());
    Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .save_installation(&Installation {
            definition: agent,
            version: "1.12.0".into(),
            artifact: root.path().into(),
        })
        .unwrap();
    let management = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    management.restore(&threads).unwrap();
    management
        .authenticate("codex", Some("fixture-login"), &threads)
        .await
        .unwrap();
    assert!(
        management.catalog(&threads).unwrap()[0]
            .authentication
            .authenticated
    );
    let draft = threads.create(root.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    std::fs::remove_file(login).unwrap();
    threads.send_message(draft.id, "expired".into()).unwrap();
    settle(&threads, draft.id).await;
    let state = &management.catalog(&threads).unwrap()[0].authentication;
    assert!(state.required);
    assert!(!state.authenticated);
    management
        .authenticate("codex", Some("fixture-login"), &threads)
        .await
        .unwrap();
    let state = &management.catalog(&threads).unwrap()[0].authentication;
    assert!(!state.required);
    assert!(state.authenticated);
    assert_eq!(threads.get(draft.id).unwrap().status, ThreadStatus::Failed);
    threads.shutdown().await;
}

#[tokio::test]
async fn cancelling_authentication_releases_the_wait_and_ignores_late_success() {
    use atte_lib::{
        agent_management::{AgentManagement, ManagementError},
        storage::{Installation, Store},
    };
    let root = tempfile::tempdir().unwrap();
    let login = root.path().join("login");
    let started = root.path().join("auth-started");
    let release = root.path().join("auth-release");
    let mut agent = mock_agent();
    agent.id = "codex".into();
    agent.env.insert("FIXTURE_MODE".into(), "slow-auth".into());
    agent
        .env
        .insert("AUTH_FILE".into(), login.to_string_lossy().into_owned());
    agent.env.insert(
        "AUTH_STARTED_FILE".into(),
        started.to_string_lossy().into_owned(),
    );
    agent.env.insert(
        "AUTH_RELEASE_FILE".into(),
        release.to_string_lossy().into_owned(),
    );
    Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .save_installation(&Installation {
            definition: agent,
            version: "1.12.0".into(),
            artifact: root.path().into(),
        })
        .unwrap();
    let management = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    management.restore(&threads).unwrap();

    let authentication = management.authenticate("codex", Some("fixture-login"), &threads);
    tokio::pin!(authentication);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            tokio::select! {
                result = &mut authentication => panic!("authentication finished early: {result:?}"),
                () = tokio::time::sleep(Duration::from_millis(10)) => {
                    if started.exists() {
                        break;
                    }
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        management
            .authenticate("codex", Some("fixture-login"), &threads)
            .await,
        Err(ManagementError::Busy)
    ));
    let (cancelled, result) = tokio::time::timeout(Duration::from_secs(1), async {
        tokio::join!(
            management.cancel_authentication("codex"),
            &mut authentication
        )
    })
    .await
    .unwrap();
    cancelled.unwrap();
    assert!(matches!(
        result,
        Err(ManagementError::AuthenticationCancelled)
    ));
    assert!(
        management
            .authenticate("codex", None, &threads)
            .await
            .unwrap()
            .connected
    );
    std::fs::write(release, "continue").unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!login.exists());
    assert!(
        !management.catalog(&threads).unwrap()[0]
            .authentication
            .authenticated
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn authentication_uses_advertised_metadata_without_provider_or_method_assumptions() {
    use atte_lib::agent_management::authentication::inspect;
    let root = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.id = "unknown-provider".into();
    agent.env.insert("FIXTURE_MODE".into(), "key-auth".into());
    let methods = inspect(&agent, root.path(), None).await.unwrap().methods;
    assert!(methods[0].description.is_none());
    assert!(methods[0].supported);
    assert!(matches!(
        inspect(&agent, root.path(), Some("api-key")).await,
        Err(atte_lib::agent_management::ManagementError::Authentication)
    ));
}

#[tokio::test]
async fn every_successful_prompt_refreshes_shared_authentication_evidence() {
    use atte_lib::{
        agent_management::AgentManagement,
        storage::{Installation, Store},
    };
    let root = tempfile::tempdir().unwrap();
    let login = root.path().join("login");
    let mut agent = mock_agent();
    agent.id = "codex".into();
    agent
        .env
        .insert("AUTH_FILE".into(), login.to_string_lossy().into_owned());
    Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .save_installation(&Installation {
            definition: agent,
            version: "1.12.0".into(),
            artifact: root.path().into(),
        })
        .unwrap();
    let management = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    management.restore(&threads).unwrap();
    management
        .authenticate("codex", Some("fixture-login"), &threads)
        .await
        .unwrap();
    let draft = threads.create(root.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads.send_message(draft.id, "first".into()).unwrap();
    settle(&threads, draft.id).await;
    assert!(management
        .authenticate("codex", Some("fixture-denied"), &threads)
        .await
        .is_err());
    assert!(
        !management.catalog(&threads).unwrap()[0]
            .authentication
            .authenticated
    );
    threads.send_message(draft.id, "second".into()).unwrap();
    settle(&threads, draft.id).await;
    assert!(
        management.catalog(&threads).unwrap()[0]
            .authentication
            .authenticated
    );
    threads.shutdown().await;
}

#[tokio::test]
async fn unknown_authentication_type_is_not_treated_as_agent_login() {
    use atte_lib::agent_management::{authentication::inspect, ManagementError};
    let root = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "future-auth".into());
    let state = inspect(&agent, root.path(), None).await.unwrap();
    assert_eq!(state.methods.len(), 1);
    assert!(!state.methods[0].supported);
    assert!(matches!(
        inspect(&agent, root.path(), Some("future-method")).await,
        Err(ManagementError::UnsupportedAuthentication)
    ));
}

#[tokio::test]
async fn negotiated_account_status_and_logout_preserve_existing_threads() {
    use atte_lib::{
        agent_management::AgentManagement,
        storage::{Installation, Store},
    };
    let root = tempfile::tempdir().unwrap();
    let login = root.path().join("login");
    let mut agent = mock_agent();
    agent.id = "codex".into();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "account-auth".into());
    agent
        .env
        .insert("AUTH_FILE".into(), login.to_string_lossy().into_owned());
    agent
        .env
        .insert("ACCOUNT_EMAIL".into(), "person@example.com".into());
    agent.env.insert("ACCOUNT_PLAN".into(), "Pro".into());
    agent
        .env
        .insert("ACCOUNT_LABEL".into(), "Do not display".into());
    agent
        .env
        .insert("ACCOUNT_ORGANIZATION".into(), "Hidden org".into());
    std::fs::write(&login, "authenticated").unwrap();
    Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .save_installation(&Installation {
            definition: agent,
            version: "1.12.0".into(),
            artifact: root.path().into(),
        })
        .unwrap();
    let management = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    management.restore(&threads).unwrap();
    let draft = threads.create(root.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads
        .send_message(draft.id, "confirm account".into())
        .unwrap();
    let before = settle(&threads, draft.id).await;
    let account = &management.catalog(&threads).unwrap()[0].authentication;
    assert!(account.authenticated);
    assert!(account.logout_supported);
    assert_eq!(account.email.as_deref(), Some("person@example.com"));
    assert_eq!(account.plan.as_deref(), Some("Pro"));

    management.logout("codex", &threads).await.unwrap();

    let account = &management.catalog(&threads).unwrap()[0].authentication;
    assert!(!account.authenticated);
    assert!(account.email.is_none());
    assert!(account.plan.is_none());
    assert_eq!(threads.get(draft.id).unwrap(), before);

    std::fs::write(&login, "authenticated again").unwrap();
    threads
        .send_message(draft.id, "confirm restored account".into())
        .unwrap();
    settle(&threads, draft.id).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !management.catalog(&threads).unwrap()[0]
            .authentication
            .authenticated
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let restored = &management.catalog(&threads).unwrap()[0].authentication;
    assert!(restored.authenticated);
    assert!(restored.logout_supported);
    assert_eq!(restored.email.as_deref(), Some("person@example.com"));
    threads.shutdown().await;
}

#[tokio::test]
async fn logout_does_not_cancel_an_active_turn_or_replace_its_runtime() {
    use atte_lib::{
        agent_management::AgentManagement,
        storage::{Installation, Store},
    };
    let root = tempfile::tempdir().unwrap();
    let login = root.path().join("login");
    let gate = root.path().join("gate");
    let mut agent = mock_agent();
    agent.id = "codex".into();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "account-auth".into());
    agent
        .env
        .insert("AUTH_FILE".into(), login.to_string_lossy().into_owned());
    agent
        .env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into_owned());
    std::fs::write(&login, "authenticated").unwrap();
    Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .save_installation(&Installation {
            definition: agent,
            version: "1.12.0".into(),
            artifact: root.path().into(),
        })
        .unwrap();
    let management = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    management.restore(&threads).unwrap();
    let draft = threads.create(root.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    threads
        .send_message(draft.id, "remain active".into())
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while threads
            .get(draft.id)
            .unwrap()
            .turns
            .last()
            .is_none_or(|turn| turn.response != "Hello")
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();

    management.logout("codex", &threads).await.unwrap();

    assert_eq!(threads.get(draft.id).unwrap().status, ThreadStatus::Running);
    std::fs::write(&login, "authenticated again").unwrap();
    std::fs::write(gate, "continue").unwrap();
    let finished = settle(&threads, draft.id).await;
    assert_eq!(finished.status, ThreadStatus::SessionReady);
    assert_eq!(finished.turns[0].response, "Hello world");
    threads.shutdown().await;
}

#[tokio::test]
async fn restart_discards_account_evidence_without_launching_agents() {
    use atte_lib::{
        agent_management::AgentManagement,
        storage::{Installation, Store},
    };
    let root = tempfile::tempdir().unwrap();
    let login = root.path().join("login");
    let requests = root.path().join("requests");
    let mut agent = mock_agent();
    agent.id = "codex".into();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "account-auth".into());
    agent
        .env
        .insert("AUTH_FILE".into(), login.to_string_lossy().into_owned());
    agent.env.insert(
        "REQUEST_LOG".into(),
        requests.to_string_lossy().into_owned(),
    );
    agent
        .env
        .insert("ACCOUNT_EMAIL".into(), "temporary@example.com".into());
    std::fs::write(&login, "authenticated").unwrap();
    Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .save_installation(&Installation {
            definition: agent,
            version: "1.12.0".into(),
            artifact: root.path().into(),
        })
        .unwrap();
    {
        let management = AgentManagement::open(root.path()).unwrap();
        let threads = Threads::new(vec![]);
        management.restore(&threads).unwrap();
        management
            .authenticate("codex", None, &threads)
            .await
            .unwrap();
        assert!(
            management.catalog(&threads).unwrap()[0]
                .authentication
                .authenticated
        );
        threads.shutdown().await;
    }
    std::fs::remove_file(&requests).unwrap();

    let management = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    management.restore(&threads).unwrap();
    let account = &management.catalog(&threads).unwrap()[0].authentication;
    assert!(!account.authenticated);
    assert!(account.email.is_none());
    assert!(account.plan.is_none());
    assert!(!requests.exists());
    threads.shutdown().await;
}

#[tokio::test]
async fn logout_is_capability_gated_and_failure_keeps_account_evidence() {
    use atte_lib::{
        agent_management::{AgentManagement, ManagementError},
        storage::{Installation, Store},
    };
    for (mode, expected) in [
        ("account-no-logout", ManagementError::UnsupportedLogout),
        ("account-logout-fails", ManagementError::Logout),
    ] {
        let root = tempfile::tempdir().unwrap();
        let login = root.path().join("login");
        let log = root.path().join("requests");
        let mut agent = mock_agent();
        agent.id = "codex".into();
        agent.env.insert("FIXTURE_MODE".into(), mode.into());
        agent
            .env
            .insert("AUTH_FILE".into(), login.to_string_lossy().into_owned());
        agent
            .env
            .insert("REQUEST_LOG".into(), log.to_string_lossy().into_owned());
        agent
            .env
            .insert("ACCOUNT_EMAIL".into(), "kept@example.com".into());
        std::fs::write(&login, "authenticated").unwrap();
        Store::open(&root.path().join("atte.sqlite"))
            .unwrap()
            .save_installation(&Installation {
                definition: agent,
                version: "1.12.0".into(),
                artifact: root.path().into(),
            })
            .unwrap();
        let management = AgentManagement::open(root.path()).unwrap();
        let threads = Threads::new(vec![]);
        management.restore(&threads).unwrap();
        management
            .authenticate("codex", None, &threads)
            .await
            .unwrap();

        let error = management.logout("codex", &threads).await.unwrap_err();

        assert_eq!(
            std::mem::discriminant(&error),
            std::mem::discriminant(&expected)
        );
        let account = &management.catalog(&threads).unwrap()[0].authentication;
        assert!(account.authenticated);
        assert_eq!(account.email.as_deref(), Some("kept@example.com"));
        let requests = std::fs::read_to_string(log).unwrap();
        assert_eq!(
            requests.matches("logout").count(),
            usize::from(mode != "account-no-logout")
        );
        threads.shutdown().await;
    }
}

#[tokio::test]
async fn unadvertised_account_status_metadata_is_ignored() {
    use atte_lib::agent_management::authentication::inspect;
    let root = tempfile::tempdir().unwrap();
    let login = root.path().join("login");
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "account-unadvertised-status".into());
    agent
        .env
        .insert("AUTH_FILE".into(), login.to_string_lossy().into_owned());
    agent
        .env
        .insert("ACCOUNT_EMAIL".into(), "ignored@example.com".into());
    std::fs::write(login, "authenticated").unwrap();

    let account = inspect(&agent, root.path(), None).await.unwrap();

    assert!(account.email.is_none());
    assert!(account.plan.is_none());
}

#[tokio::test]
async fn account_email_and_plan_are_independent_optional_extension_fields() {
    use atte_lib::agent_management::authentication::inspect;
    for (email, plan) in [
        (Some("both@example.com"), Some("Pro")),
        (Some("email@example.com"), None),
        (None, Some("Team")),
        (None, None),
    ] {
        let root = tempfile::tempdir().unwrap();
        let login = root.path().join("login");
        let mut agent = mock_agent();
        agent
            .env
            .insert("FIXTURE_MODE".into(), "account-auth".into());
        agent
            .env
            .insert("AUTH_FILE".into(), login.to_string_lossy().into_owned());
        agent
            .env
            .insert("ACCOUNT_LABEL".into(), "Ignored label".into());
        agent
            .env
            .insert("ACCOUNT_ORGANIZATION".into(), "Ignored org".into());
        if let Some(email) = email {
            agent.env.insert("ACCOUNT_EMAIL".into(), email.into());
        }
        if let Some(plan) = plan {
            agent.env.insert("ACCOUNT_PLAN".into(), plan.into());
        }
        std::fs::write(login, "authenticated").unwrap();

        let account = inspect(&agent, root.path(), None).await.unwrap();

        assert!(account.authenticated);
        assert!(account.logout_supported);
        assert_eq!(account.email.as_deref(), email);
        assert_eq!(account.plan.as_deref(), plan);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn removing_one_agent_stops_its_running_turn_and_preserves_other_agents() {
    use atte_lib::thread::ConnectionFailure;
    use nix::{sys::signal::kill, unistd::Pid};
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    let pid_file = folder.path().join("removed-pid");
    let gate = folder.path().join("gate");
    agent
        .env
        .insert("PID_FILE".into(), pid_file.to_string_lossy().into());
    agent
        .env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    let mut other = mock_agent();
    other.id = "other".into();
    let threads = Threads::new(vec![agent, other]);
    let draft = threads.create_for_agent(folder.path(), "fixture").unwrap();
    let other = threads.create_for_agent(folder.path(), "other").unwrap();
    threads.connect(draft.id).unwrap();
    threads.connect(other.id).unwrap();
    assert_eq!(
        settle(&threads, draft.id).await.status,
        ThreadStatus::SessionReady
    );
    assert_eq!(
        settle(&threads, other.id).await.status,
        ThreadStatus::SessionReady
    );
    threads
        .send_message(draft.id, "blocked response".into())
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while threads.get(draft.id).unwrap().turns[0].response != "Hello" {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let pid = Pid::from_raw(std::fs::read_to_string(pid_file).unwrap().parse().unwrap());
    threads.unregister_agent("fixture").await.unwrap();
    assert!(kill(pid, None).is_err());
    let removed = threads.get(draft.id).unwrap();
    assert_eq!(removed.failure, Some(ConnectionFailure::AgentRemoved));
    assert_eq!(removed.turns[0].response, "Hello");
    assert_eq!(removed.turns[0].stop_reason.as_deref(), Some("cancelled"));
    assert!(threads.connect(draft.id).is_err());
    assert_eq!(threads.prepared_agents()[0].id, "other");
    threads
        .send_message(other.id, "still connected".into())
        .unwrap();
    assert_eq!(
        settle(&threads, other.id).await.turns[0].response,
        "Hello world"
    );
    assert_eq!(threads.get(draft.id).unwrap(), removed);
    threads.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_waits_for_processes_being_removed() {
    use nix::{sys::signal::kill, unistd::Pid};
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    let pid_file = folder.path().join("pid");
    agent
        .env
        .insert("PID_FILE".into(), pid_file.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create_for_agent(folder.path(), "fixture").unwrap();
    threads.connect(draft.id).unwrap();
    assert_eq!(
        settle(&threads, draft.id).await.status,
        ThreadStatus::SessionReady
    );
    let pid = Pid::from_raw(std::fs::read_to_string(pid_file).unwrap().parse().unwrap());
    let (removed, ()) = tokio::join!(threads.unregister_agent("fixture"), async {
        threads.shutdown().await;
        assert!(
            kill(pid, None).is_err(),
            "shutdown must await the uninstall-owned process"
        );
    });
    removed.unwrap();
}

#[tokio::test]
async fn removing_an_agent_clears_pending_permissions_and_rejects_late_decisions() {
    use atte_lib::thread::ConnectionFailure;
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "prompt-permission".into());
    let threads = Threads::new(vec![agent]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    settle(&threads, draft.id).await;
    let mut stream = subscribe(&threads, draft.id);
    threads
        .send_message(draft.id, "request permission".into())
        .unwrap();
    let waiting = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let next = stream.recv().await.unwrap();
            if next.status == ThreadStatus::WaitingForApproval {
                break next;
            }
        }
    })
    .await
    .unwrap();
    threads.unregister_agent("fixture").await.unwrap();
    let removed = threads.get(draft.id).unwrap();
    assert_eq!(removed.failure, Some(ConnectionFailure::AgentRemoved));
    assert!(
        removed.permissions.is_empty(),
        "removed agents must not leave approval controls visible"
    );
    assert_eq!(removed.turns[0].stop_reason.as_deref(), Some("cancelled"));
    assert!(threads
        .answer_permission(
            draft.id,
            waiting.permissions[0].id,
            "arbitrary-allow".into()
        )
        .is_err());
    assert!(threads.connect(draft.id).is_err());
    assert_eq!(stream.recv().await.unwrap(), removed);
    threads.shutdown().await;
}

#[tokio::test]
async fn manual_reconnect_resumes_the_same_session_and_preserves_history() {
    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![mock_agent()]);
    let draft = threads.create(folder.path()).unwrap();
    threads.connect(draft.id).unwrap();
    let ready = settle(&threads, draft.id).await;
    threads
        .send_message(draft.id, "remember this".into())
        .unwrap();
    let completed = settle(&threads, draft.id).await;
    for _ in 0..3 {
        let connecting = threads.reconnect(draft.id).unwrap();
        assert_eq!(connecting.status, ThreadStatus::Connecting);
        assert_eq!(
            threads.reconnect(draft.id).unwrap().status,
            ThreadStatus::Connecting
        );
        let restored = settle(&threads, draft.id).await;
        assert_eq!(restored.status, ThreadStatus::SessionReady);
        assert_eq!(restored.session_id, ready.session_id);
        assert_eq!(restored.turns[0].message, completed.turns[0].message);
        assert_eq!(restored.turns[0].response, completed.turns[0].response);
    }
    threads.send_message(draft.id, "continue".into()).unwrap();
    assert_eq!(settle(&threads, draft.id).await.turns.len(), 2);
    threads.shutdown().await;
}

#[tokio::test]
async fn manual_reconnect_isolates_shared_work_and_rejects_busy_threads() {
    let folder = tempfile::tempdir().unwrap();
    let log = folder.path().join("requests.log");
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    agent
        .env
        .insert("REQUEST_LOG".into(), log.to_string_lossy().into());
    let threads = Threads::new(vec![agent]);
    let first = threads.create(folder.path()).unwrap();
    let second = threads.create(folder.path()).unwrap();
    threads.connect(first.id).unwrap();
    let ready = settle(&threads, first.id).await;
    threads.connect(second.id).unwrap();
    settle(&threads, second.id).await;
    threads.send_message(second.id, "approval".into()).unwrap();
    let mut stream = subscribe(&threads, second.id);
    let waiting = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let state = stream.recv().await.unwrap();
            if state.status == ThreadStatus::WaitingForApproval {
                break state;
            }
        }
    })
    .await
    .unwrap();
    assert!(threads.reconnect(second.id).is_err());
    threads.reconnect(first.id).unwrap();
    let restored = settle(&threads, first.id).await;
    assert_eq!(restored.session_id, ready.session_id);
    assert_eq!(restored.status, ThreadStatus::SessionReady);
    assert_eq!(
        threads.get(second.id).unwrap().permissions,
        waiting.permissions
    );
    threads
        .send_message(first.id, "after reconnect".into())
        .unwrap();
    assert_eq!(
        settle(&threads, first.id).await.turns[0].response,
        "reply:after reconnect"
    );
    let requests = std::fs::read_to_string(log).unwrap();
    assert_eq!(
        requests
            .lines()
            .filter(|line| line.starts_with("initialize "))
            .count(),
        1
    );
    assert_eq!(
        requests
            .lines()
            .filter(|line| line.starts_with("session/load "))
            .count(),
        1
    );
    assert!(!requests.contains("session/delete"));
    threads.cancel_turn(second.id, waiting.turns[0].id).unwrap();
    assert!(threads.reconnect(second.id).is_err());
    settle(&threads, second.id).await;
    threads.shutdown().await;
}
