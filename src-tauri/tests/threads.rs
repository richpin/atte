use atte_lib::thread::{ThreadUpdate, Threads};

#[test]
fn permanently_deletes_a_thread_and_its_queued_input() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("atte.sqlite");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let threads = Threads::with_store(vec![atte_lib::agent::prepared_codex()], store).unwrap();
    let deleted = threads.create(root.path()).unwrap();
    let database = rusqlite::Connection::open(&path).unwrap();
    database
        .execute(
            "UPDATE threads SET queued_messages=?2 WHERE id=?1",
            rusqlite::params![
                deleted.id.to_string(),
                serde_json::to_string(&[atte_lib::thread::QueuedMessage {
                    id: uuid::Uuid::new_v4(),
                    text: "queued".into(),
                }])
                .unwrap()
            ],
        )
        .unwrap();
    threads.delete(deleted.id).unwrap();
    let rows: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM threads WHERE id=?1",
            [deleted.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 0);
    drop(threads);
    let reopened = Threads::with_store(
        vec![],
        std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap()),
    )
    .unwrap();
    assert_eq!(
        (
            matches!(
                reopened.get(deleted.id),
                Err(atte_lib::thread::ThreadError::NotFound(_))
            ),
            rows,
        ),
        (true, 0)
    );
}

#[test]
fn publishes_the_remaining_list_after_deletion() {
    let root = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let threads = Threads::with_store(vec![atte_lib::agent::prepared_codex()], store).unwrap();
    let deleted = threads.create(root.path()).unwrap();
    let remaining = threads.create(root.path()).unwrap();
    let mut updates = threads.subscribe_list().unwrap();
    updates.blocking_recv().unwrap();

    threads.delete(deleted.id).unwrap();

    assert_eq!(
        updates
            .blocking_recv()
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>(),
        vec![remaining.id]
    );
}

#[test]
fn keeps_the_thread_and_queue_when_local_deletion_fails() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("atte.sqlite");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let threads = Threads::with_store(vec![atte_lib::agent::prepared_codex()], store).unwrap();
    let draft = threads.create(root.path()).unwrap();
    let database = rusqlite::Connection::open(&path).unwrap();
    database
        .execute_batch(
            "CREATE TRIGGER reject_thread_delete BEFORE DELETE ON threads \
             BEGIN SELECT RAISE(ABORT, 'delete rejected'); END;",
        )
        .unwrap();

    let failed = matches!(
        threads.delete(draft.id),
        Err(atte_lib::thread::ThreadError::Unavailable(_))
    );
    let rows: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM threads WHERE id=?1",
            [draft.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        (
            failed,
            threads.get(draft.id).unwrap().id,
            threads.list().unwrap()[0].id,
            rows,
        ),
        (true, draft.id, draft.id, 1)
    );
}

#[test]
fn permanently_deletes_a_restored_remote_session_without_an_installed_agent() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("atte.sqlite");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let original = Threads::with_store(vec![atte_lib::agent::prepared_codex()], store).unwrap();
    let draft = original.create(root.path()).unwrap();
    drop(original);
    let database = rusqlite::Connection::open(&path).unwrap();
    let metadata: String = database
        .query_row(
            "SELECT metadata FROM threads WHERE id=?1",
            [draft.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    let mut metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
    metadata["remoteSessionId"] = serde_json::json!("remote");
    database
        .execute(
            "UPDATE threads SET metadata=?2 WHERE id=?1",
            rusqlite::params![draft.id.to_string(), metadata.to_string()],
        )
        .unwrap();
    let restored = Threads::with_store(
        vec![],
        std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap()),
    )
    .unwrap();

    restored.delete(draft.id).unwrap();

    assert!(restored.list().unwrap().is_empty());
    let rows: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM threads WHERE id=?1",
            [draft.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn restores_queued_messages_in_order_and_keeps_the_thread_after_deletion() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("atte.sqlite");
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let original = Threads::with_store(vec![atte_lib::agent::prepared_codex()], store).unwrap();
    let draft = original.create(root.path()).unwrap();
    let empty = original.create(root.path()).unwrap();
    drop(original);
    let database = rusqlite::Connection::open(&path).unwrap();
    let messages = vec![
        atte_lib::thread::QueuedMessage {
            id: uuid::Uuid::new_v4(),
            text: "first".into(),
        },
        atte_lib::thread::QueuedMessage {
            id: uuid::Uuid::new_v4(),
            text: "second".into(),
        },
    ];
    database
        .execute(
            "UPDATE threads SET queued_messages=?2 WHERE id=?1",
            rusqlite::params![
                draft.id.to_string(),
                serde_json::to_string(&messages).unwrap()
            ],
        )
        .unwrap();
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let restored = Threads::with_store(vec![], store).unwrap();
    assert_eq!(restored.get(draft.id).unwrap().queued_messages, messages);
    assert!(restored.get(empty.id).unwrap().queued_messages.is_empty());
    restored
        .delete_queued_message(draft.id, messages[0].id)
        .unwrap();
    let saved: String = database
        .query_row(
            "SELECT queued_messages FROM threads WHERE id=?1",
            [draft.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Vec<atte_lib::thread::QueuedMessage>>(&saved).unwrap(),
        messages[1..]
    );
    restored
        .delete_queued_message(draft.id, messages[1].id)
        .unwrap();
    let saved: String = database
        .query_row(
            "SELECT queued_messages FROM threads WHERE id=?1",
            [draft.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(saved, "[]");
    assert_eq!(restored.list().unwrap().len(), 2);
    drop(restored);
    let reopened = Threads::with_store(
        vec![],
        std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap()),
    )
    .unwrap();
    assert!(reopened.get(draft.id).unwrap().queued_messages.is_empty());
}

#[test]
fn restores_the_list_without_an_installed_agent_or_a_working_folder() {
    let root = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(
        atte_lib::storage::Store::open(&root.path().join("atte.sqlite")).unwrap(),
    );
    let threads =
        Threads::with_store(vec![atte_lib::agent::prepared_codex()], store.clone()).unwrap();
    let draft = threads.create(folder.path()).unwrap();
    drop(threads);
    drop(folder);
    let restored = Threads::with_store(vec![], store).unwrap();
    let list = restored.list().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, draft.id);
    assert_eq!(list[0].agent_id, "codex");
    assert_eq!(
        restored.get(draft.id).unwrap().status,
        atte_lib::thread::ThreadStatus::Disconnected
    );
    assert!(restored.get(draft.id).unwrap().turns.is_empty());
}

#[test]
fn creates_a_local_draft_that_can_be_retrieved() {
    let folder = tempfile::tempdir().unwrap();
    let threads = Threads::default();
    let draft = threads.create(folder.path()).unwrap();
    assert_eq!(draft.working_folder, folder.path().canonicalize().unwrap());
    assert_eq!(draft.agent_id, "codex");
    assert_eq!(
        serde_json::to_value(&draft).unwrap()["status"],
        "disconnected"
    );
    assert_eq!(threads.get(draft.id).unwrap(), draft);
    assert_ne!(threads.create(folder.path()).unwrap().id, draft.id);
}

#[test]
fn rejects_files_as_working_folders() {
    let file = tempfile::NamedTempFile::new().unwrap();
    assert!(matches!(
        Threads::default().create(file.path()),
        Err(atte_lib::thread::ThreadError::InvalidWorkingFolder(_))
    ));
}

#[test]
fn rejects_a_missing_working_folder() {
    let root = tempfile::tempdir().unwrap();
    assert!(matches!(
        Threads::default().create(&root.path().join("missing")),
        Err(atte_lib::thread::ThreadError::InvalidWorkingFolder(_))
    ));
}

#[test]
fn reports_an_unknown_thread() {
    assert!(matches!(
        Threads::default().get(uuid::Uuid::new_v4()),
        Err(atte_lib::thread::ThreadError::NotFound(_))
    ));
}

#[test]
fn serializes_full_updates_with_a_thread_payload() {
    let folder = tempfile::tempdir().unwrap();
    let thread = Threads::default().create(folder.path()).unwrap();
    let value = serde_json::to_value(ThreadUpdate::Thread {
        thread: Box::new(thread.clone()),
    })
    .unwrap();
    assert_eq!(value["kind"], "thread");
    assert_eq!(value["thread"]["id"], thread.id.to_string());
}

#[test]
fn serializes_text_deltas_with_a_thread_id() {
    let thread_id = uuid::Uuid::new_v4();
    let turn_id = uuid::Uuid::new_v4();
    let value = serde_json::to_value(ThreadUpdate::TextDelta {
        thread_id,
        revision: 3,
        turn_id,
        text: "delta".into(),
    })
    .unwrap();
    assert_eq!(value["kind"], "textDelta");
    assert_eq!(value["threadId"], thread_id.to_string());
}
