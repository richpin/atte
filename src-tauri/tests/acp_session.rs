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
async fn list_subscription_tracks_background_conversation_status() {
    let folder = tempfile::tempdir().unwrap();
    let conversations = Conversations::new(vec![mock_agent()]);
    let mut list = conversations.subscribe_list().unwrap();
    assert!(list.recv().await.unwrap().is_empty());
    let draft = conversations.create(folder.path()).unwrap();
    assert_eq!(list.recv().await.unwrap()[0].id, draft.id);
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    let ready = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let entries = list.recv().await.unwrap();
            if entries[0].status == ConversationStatus::SessionReady {
                break entries;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(ready[0].id, draft.id);
    conversations.shutdown().await;
}

#[tokio::test]
async fn shutdown_stops_all_work_and_restores_queues_without_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "concurrent".into());
    let conversations = Conversations::with_store(vec![agent.clone()], store.clone()).unwrap();
    let mut ids = Vec::new();
    for message in ["hold", "approval"] {
        let draft = conversations.create(root.path()).unwrap();
        conversations.connect(draft.id).unwrap();
        settle(&conversations, draft.id).await;
        conversations
            .send_message(draft.id, message.into())
            .unwrap();
        let mut stream = subscribe(&conversations, draft.id);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let next = stream.recv().await.unwrap();
                if (message == "hold" && !next.turns[0].response.is_empty())
                    || next.status == ConversationStatus::WaitingForApproval
                {
                    break;
                }
            }
        })
        .await
        .unwrap();
        conversations
            .send_message(draft.id, "queued".into())
            .unwrap();
        ids.push(draft.id);
    }
    tokio::time::timeout(Duration::from_secs(6), conversations.shutdown())
        .await
        .unwrap();
    for id in &ids {
        let stopped = conversations.get(*id).unwrap();
        assert_eq!(stopped.status, ConversationStatus::Disconnected);
        assert_eq!(stopped.turns[0].stop_reason.as_deref(), Some("cancelled"));
        assert!(stopped.permissions.is_empty());
        assert!(conversations.send_message(*id, "late".into()).is_err());
    }
    let restored = Conversations::with_store(vec![agent], store).unwrap();
    assert_eq!(restored.list().unwrap().len(), 2);
    for id in ids {
        let saved = restored.get(id).unwrap();
        assert!(saved.interrupted);
        assert!(saved.turns.is_empty());
        assert_eq!(saved.queued_messages[0].text, "queued");
        restored.connect(id).unwrap();
        let ready = settle(&restored, id).await;
        assert_eq!(ready.status, ConversationStatus::SessionReady);
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
    let conversations = Conversations::new(vec![agent]);
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    conversations
        .send_message(draft.id, "permission".into())
        .unwrap();
    let mut stream = subscribe(&conversations, draft.id);
    tokio::time::timeout(Duration::from_secs(5), async {
        while stream.recv().await.unwrap().status != ConversationStatus::WaitingForApproval {}
    })
    .await
    .unwrap();
    conversations.shutdown().await;
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
    let conversations = Conversations::new(vec![agent]);
    let first = conversations.create(folder.path()).unwrap();
    let second = conversations.create(folder.path()).unwrap();
    conversations.connect(first.id).unwrap();
    settle(&conversations, first.id).await;
    conversations.connect(second.id).unwrap();
    let ready = settle(&conversations, second.id).await;
    assert_eq!(ready.remote_session_id.as_deref(), Some("remote-2"));
    conversations
        .send_message(first.id, "approval".into())
        .unwrap();
    let mut stream = subscribe(&conversations, first.id);
    let waiting = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let conversation = stream.recv().await.unwrap();
            if !conversation.permissions.is_empty() {
                break conversation;
            }
        }
    })
    .await
    .unwrap();
    drop(stream);
    conversations
        .send_message(second.id, "independent".into())
        .unwrap();
    assert_eq!(
        settle(&conversations, second.id).await.turns[0].response,
        "reply:independent"
    );
    conversations
        .send_message(second.id, "hold".into())
        .unwrap();
    conversations
        .cancel_turn(first.id, waiting.turns[0].id)
        .unwrap();
    assert_eq!(
        settle(&conversations, first.id).await.turns[0]
            .stop_reason
            .as_deref(),
        Some("cancelled")
    );
    assert_eq!(
        conversations.get(second.id).unwrap().status,
        ConversationStatus::Running
    );
    let second_turn = conversations.get(second.id).unwrap().turns[1].id;
    conversations.cancel_turn(second.id, second_turn).unwrap();
    settle(&conversations, second.id).await;
    conversations.send_message(first.id, "exit".into()).unwrap();
    assert_eq!(
        settle(&conversations, first.id).await.status,
        ConversationStatus::Failed
    );
    assert_eq!(
        settle(&conversations, second.id).await.status,
        ConversationStatus::Failed
    );
    conversations.shutdown().await;
}

#[tokio::test]
#[ignore = "requires ATTE_CODEX_ACP and existing login; requests then cancels permission in a temporary folder"]
async fn real_codex_concurrent_sessions_keep_approval_and_queue_isolated() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = atte_lib::agent::prepared_codex();
    agent
        .env
        .insert("INITIAL_AGENT_MODE".into(), "read-only".into());
    let conversations = Conversations::new(vec![agent]);
    let first = conversations.create(folder.path()).unwrap();
    let second = conversations.create(folder.path()).unwrap();
    conversations.connect(first.id).unwrap();
    assert_eq!(
        settle(&conversations, first.id).await.status,
        ConversationStatus::SessionReady
    );
    conversations.connect(second.id).unwrap();
    assert_eq!(
        settle(&conversations, second.id).await.status,
        ConversationStatus::SessionReady
    );
    conversations.send_message(first.id, "This is a permission UI acceptance test. Use exec_command with sandbox_permissions=require_escalated to run `printf ATTE-07 > cancelled.txt` in the working folder. Request approval and wait for it. Do not use an alternate tool or bypass approval.".into()).unwrap();
    conversations
        .send_message(
            first.id,
            "Do not execute this queued instruction after cancellation.".into(),
        )
        .unwrap();
    let mut first_stream = subscribe(&conversations, first.id);
    let waiting = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let conversation = first_stream.recv().await.unwrap();
            if conversation.status == ConversationStatus::WaitingForApproval {
                break conversation;
            }
            assert!(
                matches!(conversation.status, ConversationStatus::Running),
                "Expected permission: {conversation:?}"
            );
        }
    })
    .await
    .unwrap();
    drop(first_stream);
    conversations
        .send_message(
            second.id,
            "Do not use tools or read files. Reply with exactly ATTE-07-SECOND.".into(),
        )
        .unwrap();
    let mut second_stream = subscribe(&conversations, second.id);
    let finished = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let conversation = second_stream.recv().await.unwrap();
            if conversation.status == ConversationStatus::SessionReady
                || conversation.status == ConversationStatus::Failed
            {
                break conversation;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        finished.status,
        ConversationStatus::SessionReady,
        "{finished:?}"
    );
    assert!(finished.turns[0].response.contains("ATTE-07-SECOND"));
    assert_eq!(
        conversations.get(first.id).unwrap().status,
        ConversationStatus::WaitingForApproval
    );
    conversations
        .cancel_turn(first.id, waiting.turns[0].id)
        .unwrap();
    let stopped = settle(&conversations, first.id).await;
    assert_eq!(stopped.turns[0].stop_reason.as_deref(), Some("cancelled"));
    assert_eq!(stopped.queued_messages.len(), 1);
    assert!(!folder.path().join("cancelled.txt").exists());
    assert_eq!(conversations.get(second.id).unwrap().turns, finished.turns);
    conversations.shutdown().await;
}

#[tokio::test]
async fn queues_followups_and_dispatches_them_in_fifo_order_after_completion() {
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
    for text in ["first", "second", "third"] {
        conversations.send_message(draft.id, text.into()).unwrap();
    }
    let queued = conversations.get(draft.id).unwrap();
    assert_eq!(queued.turns.len(), 1);
    std::fs::write(gate, "continue").unwrap();
    let finished = settle(&conversations, draft.id).await;
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
    conversations.shutdown().await;
}

#[tokio::test]
async fn cancellation_intent_prevents_queue_dispatch_even_when_completion_wins_on_the_agent() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "cancel-race".into());
    let conversations = Conversations::new(vec![agent]);
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    conversations
        .send_message(draft.id, "first".into())
        .unwrap();
    conversations.send_message(draft.id, "keep".into()).unwrap();
    let turn = conversations.get(draft.id).unwrap().turns[0].id;
    conversations.cancel_turn(draft.id, turn).unwrap();
    let stopped = settle(&conversations, draft.id).await;
    assert!(stopped.interrupted);
    assert_eq!(stopped.turns.len(), 1);
    assert_eq!(stopped.queued_messages[0].text, "keep");
    conversations.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_queue_storage_does_not_acknowledge_or_send_input() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("queue.sqlite");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "cancel".into());
    let conversations = Conversations::with_store(vec![agent], store).unwrap();
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    conversations
        .send_message(draft.id, "first".into())
        .unwrap();
    let mut updates = subscribe(&conversations, draft.id);
    tokio::time::timeout(Duration::from_secs(5), async {
        while updates.recv().await.unwrap().turns[0].response.is_empty() {}
    })
    .await
    .unwrap();
    // Another SQLite client holds the storage boundary unavailable.
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(conversations
        .send_message(draft.id, "must not be acknowledged".into())
        .is_err());
    writer.execute_batch("ROLLBACK").unwrap();
    let conversation = conversations.get(draft.id).unwrap();
    assert!(conversation.queued_messages.is_empty());
    conversations
        .cancel_turn(draft.id, conversation.turns[0].id)
        .unwrap();
    assert_eq!(settle(&conversations, draft.id).await.turns.len(), 1);
    conversations.shutdown().await;
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
    let conversations = Conversations::with_store(vec![agent.clone()], store.clone()).unwrap();
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    conversations
        .send_message(draft.id, "first".into())
        .unwrap();
    conversations.send_message(draft.id, "keep".into()).unwrap();
    let mut updates = subscribe(&conversations, draft.id);
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
            let conversation = updates.recv().await.unwrap();
            if conversation.status == ConversationStatus::SessionReady {
                break conversation;
            }
        }
    })
    .await
    .unwrap();
    writer.execute_batch("ROLLBACK").unwrap();
    assert_eq!(completed.turns.len(), 1);
    assert_eq!(completed.turns[0].stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(completed.queued_messages[0].text, "keep");
    assert!(completed.notice.is_some());
    conversations.shutdown().await;
    let restored = Conversations::with_store(vec![agent], store).unwrap();
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
    let conversations = Conversations::with_store(vec![agent.clone()], store.clone()).unwrap();
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    conversations
        .send_message(draft.id, "first".into())
        .unwrap();
    conversations.send_message(draft.id, "keep".into()).unwrap();
    conversations
        .send_message(draft.id, "delete".into())
        .unwrap();
    let queued = conversations.get(draft.id).unwrap();
    conversations
        .delete_queued_message(draft.id, queued.queued_messages[1].id)
        .unwrap();
    conversations
        .cancel_turn(draft.id, queued.turns[0].id)
        .unwrap();
    let stopped = settle(&conversations, draft.id).await;
    assert_eq!(stopped.turns.len(), 1);
    assert_eq!(
        stopped
            .queued_messages
            .iter()
            .map(|message| message.text.as_str())
            .collect::<Vec<_>>(),
        ["keep"]
    );
    conversations.shutdown().await;
    drop(conversations);
    let restored = Conversations::with_store(vec![agent], store).unwrap();
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
    let conversations = Conversations::with_store(vec![agent.clone()], store.clone()).unwrap();
    let draft = conversations.create(root.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    conversations
        .send_message(draft.id, "Remember my marker".into())
        .unwrap();
    let original = settle(&conversations, draft.id).await;
    conversations.shutdown().await;
    drop(conversations);
    let restored = Conversations::with_store(vec![agent], store).unwrap();
    assert!(restored.get(draft.id).unwrap().turns.is_empty());
    assert_eq!(
        restored.list().unwrap()[0].remote_session_id,
        original.remote_session_id
    );
    restored.connect(draft.id).unwrap();
    restored.connect(draft.id).unwrap();
    let loaded = settle(&restored, draft.id).await;
    assert_eq!(loaded.status, ConversationStatus::SessionReady);
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
    let first = Conversations::with_store(vec![agent.clone()], store.clone()).unwrap();
    let draft = first.create(root.path()).unwrap();
    first.connect(draft.id).unwrap();
    settle(&first, draft.id).await;
    first.shutdown().await;
    let restored = Conversations::with_store(vec![agent], store).unwrap();
    restored.connect(draft.id).unwrap();
    let ready = settle(&restored, draft.id).await;
    assert_eq!(ready.status, ConversationStatus::SessionReady);
    assert!(ready
        .notice
        .as_deref()
        .unwrap_or_default()
        .contains("이전 메시지"));
    assert!(ready.turns.is_empty());
    restored.send_message(draft.id, "continue".into()).unwrap();
    assert!(settle(&restored, draft.id).await.notice.is_some());
    restored.shutdown().await;
}

#[tokio::test]
async fn failed_restoration_keeps_the_reference_and_never_exposes_partial_replay() {
    use atte_lib::conversation::ConnectionFailure;
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
        let first = Conversations::with_store(vec![agent.clone()], store.clone()).unwrap();
        let draft = first.create(root.path()).unwrap();
        first.connect(draft.id).unwrap();
        settle(&first, draft.id).await;
        first.send_message(draft.id, "remember".into()).unwrap();
        settle(&first, draft.id).await;
        first.shutdown().await;
        agent.env.insert("FIXTURE_MODE".into(), mode.into());
        let restored = Conversations::with_store(vec![agent.clone()], store).unwrap();
        restored.connect(draft.id).unwrap();
        let failed = settle(&restored, draft.id).await;
        assert_eq!(failed.failure, Some(failure), "{mode}");
        assert_eq!(failed.remote_session_id.as_deref(), Some("remote-1"));
        assert!(failed.turns.is_empty());
        assert!(failed.permissions.is_empty());
        agent.env.remove("FIXTURE_MODE");
        restored.register_agent(agent).unwrap();
        assert_eq!(
            restored.get(draft.id).unwrap().status,
            ConversationStatus::Failed
        );
        restored.connect(draft.id).unwrap();
        let ready = settle(&restored, draft.id).await;
        assert_eq!(ready.status, ConversationStatus::SessionReady);
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
    let first = Conversations::with_store(vec![agent.clone()], store.clone()).unwrap();
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
            if next.status == ConversationStatus::WaitingForApproval {
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
    let restored = Conversations::with_store(vec![agent], store).unwrap();
    let conversation = restored.get(draft.id).unwrap();
    assert!(conversation.interrupted);
    assert!(conversation.permissions.is_empty());
    assert!(conversation.turns.is_empty());
    assert!(restored
        .answer_permission(draft.id, permission, "arbitrary-allow".into())
        .is_err());
    restored.connect(draft.id).unwrap();
    let ready = settle(&restored, draft.id).await;
    assert_eq!(ready.status, ConversationStatus::SessionReady);
    assert!(ready.turns.is_empty());
    restored.shutdown().await;
    let reopened = Conversations::with_store(
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
    use atte_lib::conversation::ConnectionFailure;
    let root = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let first = Conversations::with_store(vec![mock_agent()], store.clone()).unwrap();
    let draft = first.create(root.path()).unwrap();
    first.connect(draft.id).unwrap();
    settle(&first, draft.id).await;
    first.shutdown().await;
    let restored = Conversations::with_store(vec![], store).unwrap();
    assert!(restored.connect(draft.id).is_err());
    assert_eq!(
        restored.get(draft.id).unwrap().failure,
        Some(ConnectionFailure::AgentRemoved)
    );
    restored.register_agent(mock_agent()).unwrap();
    assert_eq!(
        restored.get(draft.id).unwrap().status,
        ConversationStatus::Failed
    );
    restored.connect(draft.id).unwrap();
    let ready = settle(&restored, draft.id).await;
    assert_eq!(ready.status, ConversationStatus::SessionReady);
    assert_eq!(ready.remote_session_id.as_deref(), Some("remote-1"));
    restored.shutdown().await;
}

#[tokio::test]
async fn replay_keeps_distinct_message_ids_even_when_the_text_is_identical() {
    let root = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let first = Conversations::with_store(vec![mock_agent()], store.clone()).unwrap();
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
    let restored = Conversations::with_store(vec![agent], store).unwrap();
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
#[ignore = "requires ATTE_CODEX_ACP pointing to the installed Codex adapter and its existing login"]
async fn real_codex_restores_history_and_context_after_process_and_core_restart() {
    let root = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let marker = format!("ATTE-06-{}", uuid::Uuid::new_v4());
    let first =
        Conversations::with_store(vec![atte_lib::agent::prepared_codex()], store.clone()).unwrap();
    let draft = first.create(root.path()).unwrap();
    first.connect(draft.id).unwrap();
    let connected = settle(&first, draft.id).await;
    assert_eq!(
        connected.status,
        ConversationStatus::SessionReady,
        "{connected:?}"
    );
    first.send_message(draft.id, format!("Do not use tools or access any files. Remember this marker for our conversation: {marker}. Reply with only this marker.")).unwrap();
    let original = tokio::time::timeout(Duration::from_secs(120), async {
        let mut updates = subscribe(&first, draft.id);
        loop {
            let conversation = updates.recv().await.unwrap();
            if conversation.status == ConversationStatus::SessionReady
                || conversation.status == ConversationStatus::Failed
            {
                break conversation;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        original.status,
        ConversationStatus::SessionReady,
        "{original:?}"
    );
    assert!(original.turns[0].response.contains(&marker));
    first.shutdown().await;
    drop(first);
    let restored =
        Conversations::with_store(vec![atte_lib::agent::prepared_codex()], store).unwrap();
    assert!(restored.get(draft.id).unwrap().turns.is_empty());
    restored.connect(draft.id).unwrap();
    let loaded = settle(&restored, draft.id).await;
    assert_eq!(
        loaded.status,
        ConversationStatus::SessionReady,
        "{loaded:?}"
    );
    assert_eq!(loaded.remote_session_id, original.remote_session_id);
    assert!(loaded
        .turns
        .iter()
        .any(|turn| turn.response.contains(&marker)));
    restored.send_message(draft.id, "Without tools or file access, what marker did I ask you to remember? Reply with the marker only.".into()).unwrap();
    let answer = tokio::time::timeout(Duration::from_secs(120), async {
        let mut updates = subscribe(&restored, draft.id);
        loop {
            let conversation = updates.recv().await.unwrap();
            if conversation.status == ConversationStatus::SessionReady
                || conversation.status == ConversationStatus::Failed
            {
                break conversation;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        answer.status,
        ConversationStatus::SessionReady,
        "{answer:?}"
    );
    assert!(answer.turns.last().unwrap().response.contains(&marker));
    restored.shutdown().await;
}

#[tokio::test]
async fn cancels_only_the_active_turn_and_continues_the_same_session() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent.env.insert("FIXTURE_MODE".into(), "cancel".into());
    let conversations = Conversations::new(vec![agent]);
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    let mut stream = subscribe(&conversations, draft.id);
    conversations
        .send_message(draft.id, "start".into())
        .unwrap();
    let active = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let conversation = stream.recv().await.unwrap();
            if conversation
                .turns
                .last()
                .is_some_and(|turn| turn.response == "Started")
            {
                break conversation;
            }
        }
    })
    .await
    .unwrap();
    let turn = active.turns[0].id;
    conversations.cancel_turn(draft.id, turn).unwrap();
    conversations.cancel_turn(draft.id, turn).unwrap();
    let cancelled = settle(&conversations, draft.id).await;
    assert_eq!(cancelled.status, ConversationStatus::SessionReady);
    assert_eq!(cancelled.turns[0].stop_reason.as_deref(), Some("cancelled"));
    assert_eq!(cancelled.turns[0].response, "Started");
    assert!(cancelled.interrupted);
    conversations
        .send_message(draft.id, "continue".into())
        .unwrap();
    assert!(conversations.cancel_turn(draft.id, turn).is_err());
    let completed = settle(&conversations, draft.id).await;
    assert_eq!(completed.remote_session_id, active.remote_session_id);
    assert_eq!(completed.turns.len(), 2);
    assert_eq!(completed.turns[1].response, "Hello world");
    conversations.shutdown().await;
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
            let conversation = conversations.get(id).unwrap();
            if !matches!(
                conversation.status,
                ConversationStatus::Connecting
                    | ConversationStatus::Running
                    | ConversationStatus::WaitingForApproval
                    | ConversationStatus::Cancelling
            ) {
                return conversation;
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
            let conversation = conversations.get(draft.id).unwrap();
            if conversation.status == ConversationStatus::Failed {
                assert_eq!(
                    conversation.failure,
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
    let conversations = Conversations::new(vec![agent]);
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    assert_eq!(
        settle(&conversations, draft.id).await.status,
        ConversationStatus::SessionReady
    );
    let pid = Pid::from_raw(std::fs::read_to_string(pid_file).unwrap().parse().unwrap());
    conversations.shutdown().await;
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
            let conversation = conversations.get(draft.id).unwrap();
            if !matches!(
                conversation.status,
                ConversationStatus::Connecting | ConversationStatus::Running
            ) {
                break conversation;
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
            let conversation = conversations.get(draft.id).unwrap();
            if conversation.status == ConversationStatus::SessionReady {
                break conversation;
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
        let conversations = Conversations::new(vec![agent]);
        let draft = conversations.create(folder.path()).unwrap();
        conversations.connect(draft.id).unwrap();
        settle(&conversations, draft.id).await;
        conversations
            .send_message(draft.id, "first".into())
            .unwrap();
        conversations.send_message(draft.id, "keep".into()).unwrap();
        std::fs::write(gate, "continue").unwrap();
        let finished = settle(&conversations, draft.id).await;
        assert_eq!(finished.turns.len(), 1, "{mode}");
        assert_eq!(finished.queued_messages[0].text, "keep", "{mode}");
        conversations.shutdown().await;
    }
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
        agent.env.insert(
            "SESSION_FILE".into(),
            folder
                .path()
                .join("agent-history.json")
                .to_string_lossy()
                .into(),
        );
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
async fn permission_preserves_agent_choices_and_answers_exactly_once() {
    for (mode, option) in [
        ("prompt-permission", "arbitrary-allow"),
        ("prompt-permission", "deny-927"),
        ("partial-permission", "arbitrary-allow"),
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
        let waiting = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let next = stream.recv().await.unwrap();
                if next.status == ConversationStatus::WaitingForApproval {
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
        assert!(conversations
            .answer_permission(draft.id, permission.id, "unknown".into())
            .is_err());
        conversations
            .answer_permission(draft.id, permission.id, option.into())
            .unwrap();
        assert!(conversations
            .answer_permission(draft.id, permission.id, option.into())
            .is_err());
        let completed = settle(&conversations, draft.id).await;
        assert!(completed.permissions.is_empty());
        assert_eq!(
            completed.turns[0].response,
            format!("selected:{option}Hello world")
        );
        conversations.shutdown().await;
    }
}

#[tokio::test]
async fn cancelling_permission_resolves_pending_and_late_requests_without_execution() {
    let folder = tempfile::tempdir().unwrap();
    let mut agent = mock_agent();
    agent
        .env
        .insert("FIXTURE_MODE".into(), "permission-cancel".into());
    let conversations = Conversations::new(vec![agent]);
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    let mut stream = subscribe(&conversations, draft.id);
    conversations
        .send_message(draft.id, "ask permission".into())
        .unwrap();
    let waiting = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let next = stream.recv().await.unwrap();
            if next.status == ConversationStatus::WaitingForApproval {
                break next;
            }
        }
    })
    .await
    .unwrap();
    conversations
        .cancel_turn(draft.id, waiting.turns[0].id)
        .unwrap();
    assert!(conversations
        .answer_permission(
            draft.id,
            waiting.permissions[0].id,
            "arbitrary-allow".into()
        )
        .is_err());
    let cancelled = settle(&conversations, draft.id).await;
    assert_eq!(cancelled.status, ConversationStatus::SessionReady);
    assert!(cancelled.permissions.is_empty());
    assert_eq!(cancelled.turns[0].stop_reason.as_deref(), Some("cancelled"));
    assert_eq!(cancelled.turns[0].response, "");
    conversations
        .send_message(draft.id, "follow up".into())
        .unwrap();
    let completed = settle(&conversations, draft.id).await;
    assert_eq!(completed.turns[1].response, "Hello world");
    assert_eq!(completed.remote_session_id, waiting.remote_session_id);
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
    conversation: Option<atte_lib::conversation::Conversation>,
}

fn subscribe(conversations: &Conversations, id: uuid::Uuid) -> TranscriptSubscription {
    TranscriptSubscription {
        receiver: conversations.subscribe(id).unwrap(),
        conversation: None,
    }
}

impl TranscriptSubscription {
    async fn recv(&mut self) -> Option<atte_lib::conversation::Conversation> {
        use atte_lib::conversation::ConversationUpdate;
        match self.receiver.recv().await? {
            ConversationUpdate::Conversation { conversation } => {
                self.conversation = Some(*conversation)
            }
            ConversationUpdate::TextDelta {
                conversation_id,
                revision,
                turn_id,
                text,
            } => {
                let conversation = self
                    .conversation
                    .as_mut()
                    .expect("initial conversation precedes deltas");
                assert_eq!(conversation_id, conversation.id);
                assert_eq!(revision, conversation.revision + 1);
                let turn = conversation.turns.last_mut().unwrap();
                assert_eq!(turn_id, turn.id);
                turn.response.push_str(&text);
                conversation.revision = revision;
            }
        }
        self.conversation.clone()
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

#[tokio::test]
async fn installing_an_agent_preserves_the_existing_connection_and_subscription() {
    let folder = tempfile::tempdir().unwrap();
    let conversations = Conversations::new(vec![mock_agent()]);
    let draft = conversations.create(folder.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    let mut updates = conversations.subscribe(draft.id).unwrap();
    updates.recv().await.unwrap();
    let mut installed = mock_agent();
    installed.id = "installed".into();
    conversations.register_agent(installed).unwrap();
    assert_eq!(conversations.prepared_agents().len(), 2);
    conversations
        .send_message(draft.id, "hello".into())
        .unwrap();
    let ready = settle(&conversations, draft.id).await;
    assert_eq!(ready.agent_id, "fixture");
    assert_eq!(ready.turns[0].response, "Hello world");
    assert!(updates.recv().await.is_some());
    conversations.shutdown().await;
}

#[tokio::test]
async fn all_targets_authenticate_then_retry_the_same_conversation_after_expiry() {
    use atte_lib::agent_management::authentication::inspect;
    use atte_lib::conversation::{AuthenticationStatus, ConnectionFailure};
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
        let conversations = Conversations::new(vec![agent.clone()]);
        let draft = conversations.create(root.path()).unwrap();
        conversations.connect(draft.id).unwrap();
        assert_eq!(
            settle(&conversations, draft.id).await.failure,
            Some(ConnectionFailure::AuthenticationRequired)
        );
        assert!(
            inspect(&agent, root.path(), Some("fixture-login"))
                .await
                .unwrap()
                .authenticated
        );
        conversations.connect(draft.id).unwrap();
        settle(&conversations, draft.id).await;
        conversations
            .send_message(draft.id, "hello".into())
            .unwrap();
        assert_eq!(
            settle(&conversations, draft.id).await.authentication,
            AuthenticationStatus::Authenticated
        );
        std::fs::remove_file(&login).unwrap();
        conversations
            .send_message(draft.id, "expired".into())
            .unwrap();
        assert_eq!(
            settle(&conversations, draft.id).await.authentication,
            AuthenticationStatus::Required
        );
        inspect(&agent, root.path(), Some("fixture-login"))
            .await
            .unwrap();
        conversations.connect(draft.id).unwrap();
        settle(&conversations, draft.id).await;
        conversations
            .send_message(draft.id, "retry".into())
            .unwrap();
        let ready = settle(&conversations, draft.id).await;
        assert_eq!(ready.id, draft.id);
        assert_eq!(ready.agent_id, id);
        assert_eq!(ready.turns.len(), 3);
        conversations.shutdown().await;
    }
}

#[tokio::test]
async fn replacing_a_definition_preserves_live_connections_and_applies_to_new_connections() {
    let folder = tempfile::tempdir().unwrap();
    let conversations = Conversations::new(vec![mock_agent()]);
    let original = conversations.create(folder.path()).unwrap();
    conversations.connect(original.id).unwrap();
    settle(&conversations, original.id).await;
    let mut replacement = mock_agent();
    replacement.command = folder.path().join("missing-agent");
    conversations.register_agent(replacement).unwrap();
    conversations.connect(original.id).unwrap();
    assert_eq!(
        settle(&conversations, original.id).await.status,
        ConversationStatus::SessionReady
    );
    let new = conversations.create(folder.path()).unwrap();
    conversations.connect(new.id).unwrap();
    assert_eq!(
        settle(&conversations, new.id).await.failure,
        Some(atte_lib::conversation::ConnectionFailure::ExecutableNotFound)
    );
    conversations.shutdown().await;
}

#[tokio::test]
async fn management_observes_expiry_and_login_without_restarting_the_failed_conversation() {
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
    let conversations = Conversations::new(vec![]);
    management.restore(&conversations).unwrap();
    management
        .authenticate("codex", Some("fixture-login"), &conversations)
        .await
        .unwrap();
    assert!(
        management.catalog(&conversations).unwrap()[0]
            .authentication
            .authenticated
    );
    let draft = conversations.create(root.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    std::fs::remove_file(login).unwrap();
    conversations
        .send_message(draft.id, "expired".into())
        .unwrap();
    settle(&conversations, draft.id).await;
    let state = &management.catalog(&conversations).unwrap()[0].authentication;
    assert!(state.required);
    assert!(!state.authenticated);
    management
        .authenticate("codex", Some("fixture-login"), &conversations)
        .await
        .unwrap();
    let state = &management.catalog(&conversations).unwrap()[0].authentication;
    assert!(!state.required);
    assert!(state.authenticated);
    assert_eq!(
        conversations.get(draft.id).unwrap().status,
        ConversationStatus::Failed
    );
    conversations.shutdown().await;
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
    let conversations = Conversations::new(vec![]);
    management.restore(&conversations).unwrap();
    management
        .authenticate("codex", Some("fixture-login"), &conversations)
        .await
        .unwrap();
    let draft = conversations.create(root.path()).unwrap();
    conversations.connect(draft.id).unwrap();
    settle(&conversations, draft.id).await;
    conversations
        .send_message(draft.id, "first".into())
        .unwrap();
    settle(&conversations, draft.id).await;
    assert!(management
        .authenticate("codex", Some("fixture-denied"), &conversations)
        .await
        .is_err());
    assert!(
        !management.catalog(&conversations).unwrap()[0]
            .authentication
            .authenticated
    );
    conversations
        .send_message(draft.id, "second".into())
        .unwrap();
    settle(&conversations, draft.id).await;
    assert!(
        management.catalog(&conversations).unwrap()[0]
            .authentication
            .authenticated
    );
    conversations.shutdown().await;
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

#[cfg(unix)]
#[tokio::test]
async fn removing_one_agent_stops_its_running_turn_and_preserves_other_agents() {
    use atte_lib::conversation::ConnectionFailure;
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
    let conversations = Conversations::new(vec![agent, other]);
    let draft = conversations
        .create_for_agent(folder.path(), "fixture")
        .unwrap();
    let other = conversations
        .create_for_agent(folder.path(), "other")
        .unwrap();
    conversations.connect(draft.id).unwrap();
    conversations.connect(other.id).unwrap();
    assert_eq!(
        settle(&conversations, draft.id).await.status,
        ConversationStatus::SessionReady
    );
    assert_eq!(
        settle(&conversations, other.id).await.status,
        ConversationStatus::SessionReady
    );
    conversations
        .send_message(draft.id, "blocked response".into())
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while conversations.get(draft.id).unwrap().turns[0].response != "Hello" {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let pid = Pid::from_raw(std::fs::read_to_string(pid_file).unwrap().parse().unwrap());
    conversations.unregister_agent("fixture").await.unwrap();
    assert!(kill(pid, None).is_err());
    let removed = conversations.get(draft.id).unwrap();
    assert_eq!(removed.failure, Some(ConnectionFailure::AgentRemoved));
    assert_eq!(removed.turns[0].response, "Hello");
    assert_eq!(removed.turns[0].stop_reason.as_deref(), Some("cancelled"));
    assert!(conversations.connect(draft.id).is_err());
    assert_eq!(conversations.prepared_agents()[0].id, "other");
    conversations
        .send_message(other.id, "still connected".into())
        .unwrap();
    assert_eq!(
        settle(&conversations, other.id).await.turns[0].response,
        "Hello world"
    );
    assert_eq!(conversations.get(draft.id).unwrap(), removed);
    conversations.shutdown().await;
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
    let (removed, ()) = tokio::join!(conversations.unregister_agent("fixture"), async {
        conversations.shutdown().await;
        assert!(
            kill(pid, None).is_err(),
            "shutdown must await the uninstall-owned process"
        );
    });
    removed.unwrap();
}

#[tokio::test]
async fn removing_an_agent_clears_pending_permissions_and_rejects_late_decisions() {
    use atte_lib::conversation::ConnectionFailure;
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
        .send_message(draft.id, "request permission".into())
        .unwrap();
    let waiting = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let next = stream.recv().await.unwrap();
            if next.status == ConversationStatus::WaitingForApproval {
                break next;
            }
        }
    })
    .await
    .unwrap();
    conversations.unregister_agent("fixture").await.unwrap();
    let removed = conversations.get(draft.id).unwrap();
    assert_eq!(removed.failure, Some(ConnectionFailure::AgentRemoved));
    assert!(
        removed.permissions.is_empty(),
        "removed agents must not leave approval controls visible"
    );
    assert_eq!(removed.turns[0].stop_reason.as_deref(), Some("cancelled"));
    assert!(conversations
        .answer_permission(
            draft.id,
            waiting.permissions[0].id,
            "arbitrary-allow".into()
        )
        .is_err());
    assert!(conversations.connect(draft.id).is_err());
    assert_eq!(stream.recv().await.unwrap(), removed);
    conversations.shutdown().await;
}
