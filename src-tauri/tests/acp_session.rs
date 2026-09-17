use atte_lib::{
    agent::AgentDefinition,
    conversation::{ConversationStatus, Conversations},
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
        command: fixture_executable().clone(),
        args: vec![],
        env: Default::default(),
    }
}

#[tokio::test]
async fn connects_a_draft_without_replacing_its_identity_or_duplicating_sessions() {
    let folder = tempfile::tempdir().unwrap();
    let conversations = Conversations::new(vec![mock_agent()]);
    let draft = conversations
        .create_for_agent(folder.path(), "fixture")
        .unwrap();
    assert_eq!(
        conversations.connect(draft.id).unwrap().status,
        ConversationStatus::Connecting
    );
    conversations.connect(draft.id).unwrap();
    let connected = settle(&conversations, draft.id).await;
    assert_eq!(connected.status, ConversationStatus::SessionReady);
    assert_eq!(connected.remote_session_id.as_deref(), Some("remote-1"));
    assert_eq!(connected.id, draft.id);
    assert_eq!(conversations.connect(draft.id).unwrap(), connected);
    conversations.shutdown().await;
}

async fn settle(
    conversations: &Conversations,
    id: uuid::Uuid,
) -> atte_lib::conversation::Conversation {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = conversations.get(id).unwrap();
            if snapshot.status != ConversationStatus::Connecting {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn distinguishes_connection_failures_and_keeps_the_draft_for_explicit_retry() {
    use atte_lib::conversation::{AuthenticationStatus, ConnectionFailure};
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
        let conversations = Conversations::new(vec![agent]);
        let draft = conversations
            .create_for_agent(folder.path(), "fixture")
            .unwrap();
        for _ in 0..2 {
            conversations.connect(draft.id).unwrap();
            let failed = settle(&conversations, draft.id).await;
            assert_eq!(failed.status, ConversationStatus::Failed, "{mode}");
            assert_eq!(failed.failure, Some(expected.clone()), "{mode}");
            assert_eq!(failed.remote_session_id, None);
            assert_eq!(
                failed.authentication,
                if mode == "auth" {
                    AuthenticationStatus::Required
                } else {
                    AuthenticationStatus::Unknown
                }
            );
        }
        conversations.shutdown().await;
    }
}

#[tokio::test]
async fn unexpected_permission_requests_are_cancelled_without_blocking_setup() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "permission".into());
    let conversations = Conversations::new(vec![agent]);
    let draft = conversations
        .create_for_agent(folder.path(), "fixture")
        .unwrap();
    conversations.connect(draft.id).unwrap();
    assert_eq!(
        settle(&conversations, draft.id).await.status,
        ConversationStatus::SessionReady
    );
    conversations.shutdown().await;
}

#[tokio::test]
async fn process_exit_after_session_creation_is_observable() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "exit-ready".into());
    let conversations = Conversations::new(vec![agent]);
    let draft = conversations
        .create_for_agent(folder.path(), "fixture")
        .unwrap();
    conversations.connect(draft.id).unwrap();
    assert_eq!(
        settle(&conversations, draft.id).await.status,
        ConversationStatus::SessionReady
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = conversations.get(draft.id).unwrap();
            if snapshot.status == ConversationStatus::Failed {
                assert_eq!(
                    snapshot.failure,
                    Some(atte_lib::conversation::ConnectionFailure::ProcessExited)
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    conversations.shutdown().await;
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
    let conversations = Conversations::new(vec![agent]);
    let draft = conversations
        .create_for_agent(folder.path(), "fixture")
        .unwrap();
    conversations.connect(draft.id).unwrap();
    assert_eq!(
        settle(&conversations, draft.id).await.status,
        ConversationStatus::SessionReady
    );
    let pid = Pid::from_raw(std::fs::read_to_string(pid_file).unwrap().parse().unwrap());
    let child_pid = Pid::from_raw(
        std::fs::read_to_string(child_pid_file)
            .unwrap()
            .parse()
            .unwrap(),
    );
    conversations.shutdown().await;
    assert_eq!(
        conversations.get(draft.id).unwrap().status,
        ConversationStatus::Disconnected
    );
    assert!(conversations.connect(draft.id).is_err());
    tokio::time::timeout(Duration::from_secs(5), async {
        while kill(pid, None).is_ok() || kill(child_pid, None).is_ok() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
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
    let conversations = Conversations::new(vec![agent]);
    let draft = conversations
        .create_for_agent(folder.path(), "fixture")
        .unwrap();
    conversations.connect(draft.id).unwrap();
    assert_eq!(
        settle(&conversations, draft.id).await.status,
        ConversationStatus::Failed
    );
    let pid = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
    assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err());
    conversations.shutdown().await;
}

/// Opt in with ATTE_CODEX_ACP pointing at a prepared adapter executable.
#[tokio::test]
#[ignore = "requires the user's prepared Codex adapter and login"]
async fn real_codex_initializes_and_creates_a_session() {
    let folder = tempfile::tempdir().unwrap();
    let conversations = Conversations::default();
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    let connected = tokio::time::timeout(Duration::from_secs(35), async {
        loop {
            let snapshot = conversations.get(draft.id).unwrap();
            if snapshot.status != ConversationStatus::Connecting {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    conversations.shutdown().await;
    assert_eq!(
        connected.status,
        ConversationStatus::SessionReady,
        "{connected:?}"
    );
    assert!(connected.remote_session_id.is_some());
    assert_eq!(
        connected.authentication,
        atte_lib::conversation::AuthenticationStatus::Unknown
    );
}

#[tokio::test]
async fn rejects_unknown_agents_and_connecting_unknown_conversations() {
    let folder = tempfile::tempdir().unwrap();
    let conversations = Conversations::new(vec![mock_agent()]);
    assert!(conversations
        .create_for_agent(folder.path(), "unprepared")
        .is_err());
    assert!(conversations.connect(uuid::Uuid::new_v4()).is_err());
}

#[tokio::test]
async fn connecting_a_draft_revalidates_a_removed_working_folder() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("project");
    std::fs::create_dir(&folder).unwrap();
    let conversations = Conversations::new(vec![mock_agent()]);
    let draft = conversations.create_for_agent(&folder, "fixture").unwrap();
    std::fs::remove_dir(&folder).unwrap();
    assert!(matches!(
        conversations.connect(draft.id),
        Err(atte_lib::conversation::ConversationError::InvalidWorkingFolder(_))
    ));
    assert_eq!(
        conversations.get(draft.id).unwrap().status,
        ConversationStatus::Disconnected
    );
}
