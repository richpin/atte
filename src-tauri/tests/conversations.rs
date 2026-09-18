use atte_lib::conversation::Conversations;

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
