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

#[tokio::test]
async fn streams_ordered_turns_and_sends_followups_in_the_same_session() {
    let folder = tempfile::tempdir().unwrap();
    let conversations = Conversations::new(vec![mock_agent()]);
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    let mut stream = subscribe(&conversations, draft.id);
    let initial = stream.recv().await.unwrap();
    conversations
        .send_message(draft.id, "hello".into())
        .unwrap();
    assert!(conversations
        .send_message(draft.id, "duplicate".into())
        .is_err());
    let mut revision = initial.revision;
    let mut texts = Vec::new();
    loop {
        let next = tokio::time::timeout(Duration::from_secs(5), stream.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(next.revision, revision + 1);
        revision = next.revision;
        texts.push(next.turns[0].response.clone());
        if next.status == ConversationStatus::SessionReady {
            break;
        }
    }
    assert_eq!(texts, ["", "Hello", "Hello world", "Hello world"]);
    conversations
        .send_message(draft.id, "again".into())
        .unwrap();
    loop {
        let next = tokio::time::timeout(Duration::from_secs(5), stream.recv())
            .await
            .unwrap()
            .unwrap();
        if next.status == ConversationStatus::SessionReady {
            assert_eq!(next.remote_session_id.as_deref(), Some("remote-1"));
            assert_eq!(next.turns.len(), 2);
            assert_eq!(next.turns[1].response, "Hello world");
            assert_eq!(next.turns[1].stop_reason.as_deref(), Some("end_turn"));
            break;
        }
    }
    conversations.shutdown().await;
}

#[tokio::test]
async fn resubscription_is_coherent_and_detaching_does_not_stop_a_turn() {
    let folder = tempfile::tempdir().unwrap();
    let gate = folder.path().join("continue");
    let mut agent = mock_agent();
    agent
        .env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    let conversations = Conversations::new(vec![agent]);
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    assert!(conversations.send_message(draft.id, "  ".into()).is_err());
    conversations
        .send_message(draft.id, "hello".into())
        .unwrap();
    let mut stream = subscribe(&conversations, draft.id);
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
    let mut resumed = subscribe(&conversations, draft.id);
    assert_eq!(resumed.recv().await.unwrap(), first);
    drop(resumed);
    std::fs::write(gate, "continue").unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = conversations.get(draft.id).unwrap();
            if snapshot.status == ConversationStatus::SessionReady {
                break snapshot;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut resumed = subscribe(&conversations, draft.id);
    assert_eq!(resumed.recv().await.unwrap(), completed);
    assert_eq!(completed.turns[0].response, "Hello world");
    assert_eq!(completed.revision, first.revision + 2);
    conversations.shutdown().await;
}

#[tokio::test]
async fn prompt_failures_preserve_partial_output_and_reject_stale_updates() {
    use atte_lib::conversation::ConnectionFailure;
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
        agent.env.insert("FIXTURE_MODE".into(), mode.into());
        let conversations = Conversations::new(vec![agent]);
        let draft = conversations.create(folder.path()).unwrap();
        conversations.connect(draft.id).unwrap();
        settle(&conversations, draft.id).await;
        let mut stream = subscribe(&conversations, draft.id);
        conversations
            .send_message(draft.id, "hello".into())
            .unwrap();
        let failed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let next = stream.recv().await.unwrap();
                if next.status == ConversationStatus::Failed {
                    break next;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(failed.failure, Some(failure), "{mode}");
        assert_eq!(failed.turns[0].response, "Hello world");
        assert!(conversations
            .send_message(draft.id, "retry".into())
            .is_err());
        conversations.connect(draft.id).unwrap();
        let reconnected = settle(&conversations, draft.id).await;
        assert_eq!(reconnected.status, ConversationStatus::SessionReady);
        assert_eq!(reconnected.turns[0].response, "Hello world");
        conversations.shutdown().await;
    }
}

#[tokio::test]
async fn permission_is_cancelled_with_a_visible_reason_and_foreign_output_is_ignored() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "prompt-permission".into());
    let conversations = Conversations::new(vec![agent]);
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    let mut stream = subscribe(&conversations, draft.id);
    conversations
        .send_message(draft.id, "hello".into())
        .unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let next = stream.recv().await.unwrap();
            if next.turns.len() == 1 && next.status == ConversationStatus::SessionReady {
                break next;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(completed.turns[0].response, "Hello world");
    assert!(completed.notice.unwrap().contains("취소"));
    conversations.shutdown().await;
}

#[tokio::test]
#[ignore = "requires the user's prepared Codex adapter and login"]
async fn real_codex_streams_and_continues_without_file_changes() {
    let folder = tempfile::tempdir().unwrap();
    let conversations = Conversations::default();
    let draft = conversations.create(folder.path()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(120), async {
        let mut stream = subscribe(&conversations, draft.id);
        conversations.connect(draft.id).unwrap();
        loop {
            let next = stream.recv().await.unwrap();
            if next.status == ConversationStatus::Failed { return Err(format!("{next:?}")); }
            if next.status == ConversationStatus::SessionReady { break; }
        }
        let session = conversations.get(draft.id).unwrap().remote_session_id;
        for message in [
            "Do not use tools or read or modify any files. Remember the token cobalt-73 for this conversation. Reply with exactly: Remembered cobalt-73.",
            "Do not use tools or read or modify any files. What token did I ask you to remember? Reply with the token only.",
        ] {
            conversations.send_message(draft.id, message.into()).unwrap();
            let mut streamed = 0;
            loop {
                let next = stream.recv().await.unwrap();
                if next.status == ConversationStatus::Failed { return Err(format!("{next:?}")); }
                if let Some(turn) = next.turns.last() {
                    if next.status == ConversationStatus::Running && !turn.response.is_empty() { streamed += 1; }
                    if next.status == ConversationStatus::SessionReady {
                        assert_eq!(next.remote_session_id, session);
                        assert_eq!(turn.stop_reason.as_deref(), Some("end_turn"));
                        assert!(turn.response.contains("cobalt-73"), "{}", turn.response);
                        assert!(streamed > 0);
                        println!("turn {}: {streamed} streamed revisions; response: {}", next.turns.len(), turn.response);
                        break;
                    }
                }
            }
        }
        assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 0);
        Ok::<_, String>(())
    }).await;
    conversations.shutdown().await;
    result.unwrap().unwrap();
}

struct TranscriptSubscription {
    receiver: tokio::sync::mpsc::UnboundedReceiver<atte_lib::conversation::ConversationUpdate>,
    snapshot: Option<atte_lib::conversation::Conversation>,
}

fn subscribe(conversations: &Conversations, id: uuid::Uuid) -> TranscriptSubscription {
    TranscriptSubscription {
        receiver: conversations.subscribe(id).unwrap(),
        snapshot: None,
    }
}

impl TranscriptSubscription {
    async fn recv(&mut self) -> Option<atte_lib::conversation::Conversation> {
        use atte_lib::conversation::ConversationUpdate;
        match self.receiver.recv().await? {
            ConversationUpdate::Snapshot { snapshot } => self.snapshot = Some(*snapshot),
            ConversationUpdate::TextDelta {
                conversation_id,
                revision,
                turn_id,
                text,
            } => {
                let snapshot = self
                    .snapshot
                    .as_mut()
                    .expect("initial snapshot precedes deltas");
                assert_eq!(conversation_id, snapshot.id);
                assert_eq!(revision, snapshot.revision + 1);
                let turn = snapshot.turns.last_mut().unwrap();
                assert_eq!(turn_id, turn.id);
                turn.response.push_str(&text);
                snapshot.revision = revision;
            }
        }
        self.snapshot.clone()
    }
}

#[tokio::test]
async fn preserves_authentication_error_when_process_exit_races_with_buffered_output() {
    use atte_lib::conversation::{AuthenticationStatus, ConnectionFailure};
    let folder = tempfile::tempdir().unwrap();
    let gate = folder.path().join("continue");
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "prompt-auth-exit".into());
    agent
        .env
        .insert("PROMPT_GATE".into(), gate.to_string_lossy().into());
    let conversations = Conversations::new(vec![agent]);
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    let mut stream = subscribe(&conversations, draft.id);
    conversations
        .send_message(draft.id, "hello".into())
        .unwrap();
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
            if next.status == ConversationStatus::Failed {
                break next;
            }
        }
    })
    .await
    .unwrap();
    conversations.shutdown().await;
    assert_eq!(
        failed.failure,
        Some(ConnectionFailure::AuthenticationRequired)
    );
    assert_eq!(failed.authentication, AuthenticationStatus::Required);
    assert_eq!(failed.turns[0].response, "Hello world");
}
