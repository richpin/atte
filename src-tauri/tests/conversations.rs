use atte_lib::conversation::Conversations;

#[test]
fn migrates_separate_queues_into_conversation_rows_without_losing_order() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("atte.sqlite");
    let original = Conversations::default();
    let draft = original.create(root.path()).unwrap();
    let empty = original.create(root.path()).unwrap();
    let database = rusqlite::Connection::open(&path).unwrap();
    for migration in [
        include_str!("../migrations/001_agents.sql"),
        include_str!("../migrations/002_conversations.sql"),
        include_str!("../migrations/003_queued_messages.sql"),
    ] {
        database.execute_batch(migration).unwrap();
    }
    for metadata in original.list().unwrap() {
        database
            .execute(
                "INSERT INTO conversations VALUES (?1, ?2)",
                rusqlite::params![
                    metadata.id.to_string(),
                    serde_json::to_string(&metadata).unwrap()
                ],
            )
            .unwrap();
    }
    let messages = vec![
        atte_lib::conversation::QueuedMessage {
            id: uuid::Uuid::new_v4(),
            text: "first".into(),
        },
        atte_lib::conversation::QueuedMessage {
            id: uuid::Uuid::new_v4(),
            text: "second".into(),
        },
    ];
    database
        .execute(
            "INSERT INTO conversation_queues VALUES (?1, ?2)",
            rusqlite::params![
                draft.id.to_string(),
                serde_json::to_string(&messages).unwrap()
            ],
        )
        .unwrap();
    let store = std::sync::Arc::new(atte_lib::storage::Store::open(&path).unwrap());
    let restored = Conversations::with_store(vec![], store).unwrap();
    assert_eq!(restored.get(draft.id).unwrap().queued_messages, messages);
    assert!(restored.get(empty.id).unwrap().queued_messages.is_empty());
    restored
        .delete_queued_message(draft.id, messages[0].id)
        .unwrap();
    let saved: String = database
        .query_row(
            "SELECT queued_messages FROM conversations WHERE id=?1",
            [draft.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Vec<atte_lib::conversation::QueuedMessage>>(&saved).unwrap(),
        messages[1..]
    );
    restored
        .delete_queued_message(draft.id, messages[1].id)
        .unwrap();
    let saved: String = database
        .query_row(
            "SELECT queued_messages FROM conversations WHERE id=?1",
            [draft.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(saved, "[]");
    assert_eq!(restored.list().unwrap().len(), 2);
    assert!(!database.table_exists(None, "conversation_queues").unwrap());
    drop(restored);
    let reopened = Conversations::with_store(
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
    let conversations =
        Conversations::with_store(vec![atte_lib::agent::prepared_codex()], store.clone()).unwrap();
    let draft = conversations.create(folder.path()).unwrap();
    drop(conversations);
    drop(folder);
    let restored = Conversations::with_store(vec![], store).unwrap();
    let list = restored.list().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, draft.id);
    assert_eq!(list[0].agent_id, "codex");
    assert_eq!(
        restored.get(draft.id).unwrap().status,
        atte_lib::conversation::ConversationStatus::Disconnected
    );
    assert!(restored.get(draft.id).unwrap().turns.is_empty());
}

#[test]
fn creates_a_local_draft_that_can_be_retrieved() {
    let folder = tempfile::tempdir().unwrap();
    let conversations = Conversations::default();
    let draft = conversations.create(folder.path()).unwrap();
    assert_eq!(draft.working_folder, folder.path().canonicalize().unwrap());
    assert_eq!(draft.agent_id, "codex");
    assert_eq!(
        serde_json::to_value(&draft).unwrap()["status"],
        "disconnected"
    );
    assert_eq!(conversations.get(draft.id).unwrap(), draft);
    assert_ne!(conversations.create(folder.path()).unwrap().id, draft.id);
}

#[test]
fn rejects_files_as_working_folders() {
    let file = tempfile::NamedTempFile::new().unwrap();
    assert!(matches!(
        Conversations::default().create(file.path()),
        Err(atte_lib::conversation::ConversationError::InvalidWorkingFolder(_))
    ));
}

#[test]
fn rejects_a_missing_working_folder() {
    let root = tempfile::tempdir().unwrap();
    assert!(matches!(
        Conversations::default().create(&root.path().join("missing")),
        Err(atte_lib::conversation::ConversationError::InvalidWorkingFolder(_))
    ));
}

#[test]
fn reports_an_unknown_conversation() {
    assert!(matches!(
        Conversations::default().get(uuid::Uuid::new_v4()),
        Err(atte_lib::conversation::ConversationError::NotFound(_))
    ));
}
