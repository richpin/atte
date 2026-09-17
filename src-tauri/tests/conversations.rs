use atte_lib::conversation::Conversations;

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
