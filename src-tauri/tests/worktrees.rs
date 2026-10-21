use atte_lib::{
    agent::prepared_codex,
    storage::Store,
    thread::Threads,
    worktree::{inspect, PreparedWorktree},
};
use std::{path::Path, process::Command, sync::Arc};
use uuid::Uuid;

fn git(folder: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        // A pre-commit hook's index belongs to its repository, not this fixture checkout.
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .arg("-C")
        .arg(folder)
        .args([
            "-c",
            "user.name=Worktree Test",
            "-c",
            "user.email=worktree@example.invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn repository() -> tempfile::TempDir {
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "--quiet"]);
    std::fs::create_dir_all(repo.path().join("packages/app")).unwrap();
    std::fs::write(repo.path().join("packages/app/main.ts"), "committed").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "--quiet", "-m", "initial"]);
    repo
}

#[tokio::test]
async fn shares_current_files_and_subfolder_but_starts_an_empty_conversation() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    let mut alternative = prepared_codex();
    alternative.id = "alternative".into();
    let threads = Threads::new(vec![prepared_codex(), alternative]);
    let first = threads
        .create_in_worktree(&repo.path().join("packages/app"), parent.path(), "codex")
        .await
        .unwrap();
    let checkout = first.worktree.as_ref().unwrap();
    std::fs::write(first.working_folder.join("main.ts"), "dirty shared work").unwrap();
    std::fs::write(first.working_folder.join("untracked"), "shared file").unwrap();
    let second = threads
        .create_in_existing_worktree(first.id, "alternative")
        .await
        .unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(second.working_folder, first.working_folder);
    assert_eq!(second.worktree, first.worktree);
    assert_eq!(second.agent_id, "alternative");
    assert!(second.session_id.is_none());
    assert!(second.turns.is_empty());
    assert!(second.queued_messages.is_empty());
    assert!(second.pending_interactions.is_empty());
    assert!(second.configuration.is_empty());
    assert_eq!(
        std::fs::read_to_string(second.working_folder.join("main.ts")).unwrap(),
        "dirty shared work"
    );
    assert_eq!(
        std::fs::read_to_string(second.working_folder.join("untracked")).unwrap(),
        "shared file"
    );
    assert_eq!(
        git(repo.path(), &["worktree", "list", "--porcelain"])
            .matches("worktree ")
            .count(),
        2
    );
    threads.delete(first.id).await.unwrap();
    assert!(checkout.root.exists());
    let third = threads
        .create_in_existing_worktree(second.id, "codex")
        .await
        .unwrap();
    threads.delete(second.id).await.unwrap();
    assert!(checkout.root.exists());
    threads.delete(third.id).await.unwrap();
    assert!(!checkout.root.exists());
}

#[tokio::test]
async fn recognizes_manual_folders_and_repairs_legacy_membership_durably_on_restart() {
    let repo = repository();
    let data = tempfile::tempdir().unwrap();
    let database = data.path().join("atte.sqlite");
    let store = Arc::new(Store::open(&database).unwrap());
    let threads = Threads::with_store(vec![prepared_codex()], store).unwrap();
    let first = threads
        .create_in_worktree(repo.path(), &data.path().join("worktrees"), "codex")
        .await
        .unwrap();
    let checkout = first.worktree.as_ref().unwrap();
    let manual = threads
        .create_for_agent(&checkout.root.join("packages/app"), "codex")
        .unwrap();
    assert_eq!(manual.worktree, first.worktree);
    // Simulate an existing v1 record made before automatic membership recognition.
    rusqlite::Connection::open(&database)
        .unwrap()
        .execute(
            "UPDATE threads SET worktree=NULL WHERE id=?1",
            [manual.id.to_string()],
        )
        .unwrap();
    drop(threads);
    let restored = Threads::with_store(
        vec![prepared_codex()],
        Arc::new(Store::open(&database).unwrap()),
    )
    .unwrap();
    assert_eq!(restored.get(manual.id).unwrap().worktree, first.worktree);
    restored.delete(first.id).await.unwrap();
    drop(restored);
    let restored = Threads::with_store(
        vec![prepared_codex()],
        Arc::new(Store::open(&database).unwrap()),
    )
    .unwrap();
    assert_eq!(restored.get(manual.id).unwrap().worktree, first.worktree);
    restored.delete(manual.id).await.unwrap();
    assert!(!checkout.root.exists());
}

#[tokio::test]
async fn failed_shared_creation_never_removes_or_changes_the_checkout() {
    let repo = repository();
    let data = tempfile::tempdir().unwrap();
    let database = data.path().join("atte.sqlite");
    let threads = Threads::with_store(
        vec![prepared_codex()],
        Arc::new(Store::open(&database).unwrap()),
    )
    .unwrap();
    let first = threads
        .create_in_worktree(repo.path(), &data.path().join("worktrees"), "codex")
        .await
        .unwrap();
    let checkout = first.worktree.as_ref().unwrap();
    std::fs::write(checkout.root.join("keep"), "shared changes").unwrap();
    let db = rusqlite::Connection::open(&database).unwrap();
    db.execute_batch("CREATE TRIGGER reject_insert BEFORE INSERT ON threads BEGIN SELECT RAISE(ABORT, 'rejected'); END;").unwrap();
    assert!(threads
        .create_in_existing_worktree(first.id, "codex")
        .await
        .is_err());
    assert_eq!(threads.list().unwrap().len(), 1);
    assert_eq!(
        std::fs::read_to_string(checkout.root.join("keep")).unwrap(),
        "shared changes"
    );
    db.execute_batch("DROP TRIGGER reject_insert;").unwrap();
    let second = threads
        .create_in_existing_worktree(first.id, "codex")
        .await
        .unwrap();
    db.execute_batch("CREATE TRIGGER reject_delete BEFORE DELETE ON threads BEGIN SELECT RAISE(ABORT, 'rejected'); END;").unwrap();
    assert!(threads.delete(first.id).await.is_err());
    assert_eq!(threads.list().unwrap().len(), 2);
    assert!(checkout.root.exists());
    db.execute_batch("DROP TRIGGER reject_delete;").unwrap();
    threads.delete(first.id).await.unwrap();
    git(
        &checkout.root,
        &["worktree", "lock", checkout.root.to_str().unwrap()],
    );
    assert!(threads.delete(second.id).await.is_err());
    assert!(threads.get(second.id).is_ok());
    assert!(checkout.root.exists());
    git(
        &checkout.root,
        &["worktree", "unlock", checkout.root.to_str().unwrap()],
    );
    threads.delete(second.id).await.unwrap();
}

#[tokio::test]
async fn rejects_stale_sources_unmanaged_threads_unavailable_agents_and_broken_checkouts() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![prepared_codex()]);
    let local = threads.create(repo.path()).unwrap();
    assert!(threads
        .create_in_existing_worktree(local.id, "codex")
        .await
        .is_err());
    let first = threads
        .create_in_worktree(repo.path(), parent.path(), "codex")
        .await
        .unwrap();
    assert!(threads
        .create_in_existing_worktree(first.id, "missing")
        .await
        .is_err());
    let second = threads
        .create_in_existing_worktree(first.id, "codex")
        .await
        .unwrap();
    threads.delete(first.id).await.unwrap();
    assert!(threads
        .create_in_existing_worktree(first.id, "codex")
        .await
        .is_err());
    let checkout = second.worktree.as_ref().unwrap();
    std::fs::remove_file(checkout.root.join(".git")).unwrap();
    assert!(threads
        .create_in_existing_worktree(second.id, "codex")
        .await
        .is_err());
    assert!(threads
        .create_for_agent(&second.working_folder, "codex")
        .is_err());
    assert_eq!(threads.list().unwrap().len(), 2);
}

#[tokio::test]
async fn creation_and_last_reference_deletion_cannot_leave_a_thread_in_a_removed_checkout() {
    for create_first in [false, true] {
        let repo = repository();
        let parent = tempfile::tempdir().unwrap();
        let threads = Threads::new(vec![prepared_codex()]);
        let first = threads
            .create_in_worktree(repo.path(), parent.path(), "codex")
            .await
            .unwrap();
        let checkout = first.worktree.as_ref().unwrap();
        let create = threads.create_in_existing_worktree(first.id, "codex");
        let delete = threads.delete(first.id);
        let (created, deleted) = if create_first {
            tokio::join!(biased; create, delete)
        } else {
            let (deleted, created) = tokio::join!(biased; delete, create);
            (created, deleted)
        };
        deleted.unwrap();
        match created {
            Ok(thread) => {
                assert!(checkout.root.exists());
                assert!(threads.get(thread.id).is_ok());
                threads.delete(thread.id).await.unwrap();
            }
            Err(_) => assert!(threads.list().unwrap().is_empty()),
        }
        assert!(!checkout.root.exists());
    }
}

#[tokio::test]
async fn isolates_committed_files_at_head_and_preserves_the_selected_subfolder() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    std::fs::write(repo.path().join("packages/app/main.ts"), "dirty").unwrap();
    std::fs::write(repo.path().join("untracked"), "local").unwrap();
    let source = repo.path().join("packages/app");
    let original_head = git(repo.path(), &["rev-parse", "HEAD"]);
    let original_branches = git(repo.path(), &["branch", "--format=%(refname)"]);
    let prepared = PreparedWorktree::create(&source, parent.path(), Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(prepared.working_folder.join("main.ts")).unwrap(),
        "committed"
    );
    assert!(!prepared.metadata.root.join("untracked").exists());
    assert_eq!(
        git(&prepared.metadata.root, &["rev-parse", "HEAD"]),
        original_head
    );
    assert_eq!(
        git(
            &prepared.metadata.root,
            &["rev-parse", "--abbrev-ref", "HEAD"]
        ),
        "HEAD"
    );
    assert_eq!(
        git(repo.path(), &["branch", "--format=%(refname)"]),
        original_branches
    );
    assert_eq!(
        std::fs::read_to_string(source.join("main.ts")).unwrap(),
        "dirty"
    );
    assert_eq!(
        prepared.metadata.source_folder,
        source.canonicalize().unwrap()
    );
    assert!(prepared.working_folder.ends_with("packages/app"));
    assert!(atte_lib::worktree::validate(&prepared.metadata, &prepared.working_folder).is_ok());
}

#[tokio::test]
async fn creates_independent_worktrees_from_a_linked_checkout() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    let first = PreparedWorktree::create(repo.path(), parent.path(), Uuid::new_v4())
        .await
        .unwrap();
    let second = PreparedWorktree::create(&first.metadata.root, parent.path(), Uuid::new_v4())
        .await
        .unwrap();
    assert_ne!(first.metadata.root, second.metadata.root);
    assert_eq!(
        git(&first.metadata.root, &["rev-parse", "HEAD"]),
        git(&second.metadata.root, &["rev-parse", "HEAD"])
    );
}

#[tokio::test]
async fn rejects_non_repositories_empty_repositories_and_bare_repositories() {
    let folder = tempfile::tempdir().unwrap();
    assert_eq!(
        inspect(folder.path()).await.unavailable_reason,
        Some("notRepository")
    );
    git(folder.path(), &["init", "--quiet"]);
    assert_eq!(
        inspect(folder.path()).await.unavailable_reason,
        Some("noCommit")
    );
    let bare = tempfile::tempdir().unwrap();
    git(bare.path(), &["init", "--bare", "--quiet"]);
    assert_eq!(
        inspect(bare.path()).await.unavailable_reason,
        Some("bareRepository")
    );
}

#[tokio::test]
async fn rolls_back_when_the_selected_subfolder_is_not_committed() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    let source = repo.path().join("local-only");
    std::fs::create_dir(&source).unwrap();
    let id = Uuid::new_v4();
    assert!(PreparedWorktree::create(&source, parent.path(), id)
        .await
        .is_err());
    assert!(!parent.path().join(id.to_string()).exists());
    assert_eq!(
        git(repo.path(), &["worktree", "list", "--porcelain"])
            .matches("worktree ")
            .count(),
        1
    );
}

#[tokio::test]
async fn never_overwrites_an_existing_destination() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    let id = Uuid::new_v4();
    std::fs::create_dir(parent.path().join(id.to_string())).unwrap();
    let sentinel = parent.path().join(id.to_string()).join("keep");
    std::fs::write(&sentinel, "keep").unwrap();
    assert!(PreparedWorktree::create(repo.path(), parent.path(), id)
        .await
        .is_err());
    assert!(sentinel.exists());
}

#[tokio::test]
async fn retains_dirty_files_when_rollback_cannot_safely_remove_them() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    let prepared = PreparedWorktree::create(repo.path(), parent.path(), Uuid::new_v4())
        .await
        .unwrap();
    std::fs::write(prepared.metadata.root.join("keep"), "user work").unwrap();
    let error = prepared.rollback_error("save failed".into()).await;
    assert!(error.contains(prepared.metadata.root.to_str().unwrap()));
    assert_eq!(
        std::fs::read_to_string(prepared.metadata.root.join("keep")).unwrap(),
        "user work"
    );
}

#[tokio::test]
async fn restores_metadata_and_removes_checkout_after_thread_deletion() {
    let repo = repository();
    let data = tempfile::tempdir().unwrap();
    let database = data.path().join("atte.sqlite");
    let store = Arc::new(Store::open(&database).unwrap());
    let threads = Threads::with_store(vec![prepared_codex()], store).unwrap();
    let draft = threads
        .create_in_worktree(
            &repo.path().join("packages/app"),
            &data.path().join("worktrees"),
            "codex",
        )
        .await
        .unwrap();
    let worktree = draft.worktree.clone().unwrap();
    assert_eq!(
        threads.list().unwrap()[0].worktree.as_ref(),
        Some(&worktree)
    );
    std::fs::write(draft.working_folder.join("main.ts"), "new commit").unwrap();
    git(&worktree.root, &["add", "."]);
    git(&worktree.root, &["commit", "--quiet", "-m", "work"]);
    let commit = git(&worktree.root, &["rev-parse", "HEAD"]);
    drop(threads);
    let restored = Threads::with_store(
        vec![prepared_codex()],
        Arc::new(Store::open(&database).unwrap()),
    )
    .unwrap();
    assert_eq!(
        restored.get(draft.id).unwrap().worktree.as_ref(),
        Some(&worktree)
    );
    assert_eq!(
        restored.get(draft.id).unwrap().working_folder,
        draft.working_folder
    );
    restored.delete(draft.id).await.unwrap();
    assert!(!worktree.root.exists());
    assert!(!worktree.root.parent().unwrap().exists());
    assert!(restored.get(draft.id).is_err());
    assert!(!git(repo.path(), &["worktree", "list", "--porcelain"])
        .contains(worktree.root.to_str().unwrap()));
    // Removing a checkout does not erase objects from the shared repository.
    assert_eq!(git(repo.path(), &["rev-parse", &commit]), commit);
}

#[tokio::test]
async fn rolls_back_checkout_when_thread_storage_fails() {
    let repo = repository();
    let data = tempfile::tempdir().unwrap();
    let database = data.path().join("atte.sqlite");
    let store = Arc::new(Store::open(&database).unwrap());
    let threads = Threads::with_store(vec![prepared_codex()], store).unwrap();
    rusqlite::Connection::open(database).unwrap().execute_batch("CREATE TRIGGER reject_thread BEFORE INSERT ON threads BEGIN SELECT RAISE(ABORT, 'rejected'); END;").unwrap();
    let parent = data.path().join("worktrees");
    assert!(threads
        .create_in_worktree(repo.path(), &parent, "codex")
        .await
        .is_err());
    assert!(threads.list().unwrap().is_empty());
    assert_eq!(std::fs::read_dir(parent).unwrap().count(), 0);
    assert_eq!(
        git(repo.path(), &["worktree", "list", "--porcelain"])
            .matches("worktree ")
            .count(),
        1
    );
}

#[tokio::test]
async fn refuses_missing_or_disconnected_worktrees_without_falling_back_to_source() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![prepared_codex()]);
    let draft = threads
        .create_in_worktree(repo.path(), parent.path(), "codex")
        .await
        .unwrap();
    let worktree = draft.worktree.clone().unwrap();
    std::fs::remove_file(worktree.root.join(".git")).unwrap();
    assert!(threads.connect(draft.id).is_err());
    std::fs::remove_dir_all(&worktree.root).unwrap();
    assert!(threads.connect(draft.id).is_err());
    assert_eq!(
        threads.get(draft.id).unwrap().working_folder,
        draft.working_folder
    );
}

#[test]
fn reports_missing_git_without_changing_the_parent_process_environment() {
    const PROBE: &str = "ATTE_WORKTREE_MISSING_GIT_PROBE";
    let folder = tempfile::tempdir().unwrap();
    if std::env::var_os(PROBE).is_some() {
        let info = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(inspect(folder.path()));
        assert_eq!(info.unavailable_reason, Some("gitUnavailable"));
        return;
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "reports_missing_git_without_changing_the_parent_process_environment",
        ])
        .env(PROBE, "1")
        .env("PATH", folder.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn cleans_up_the_container_when_git_rejects_creation() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    std::fs::write(repo.path().join(".git/worktrees"), "not a directory").unwrap();
    assert!(
        PreparedWorktree::create(repo.path(), parent.path(), Uuid::new_v4())
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn concurrent_creations_use_distinct_paths_and_revalidate_head() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    let old = inspect(repo.path()).await.commit.unwrap();
    std::fs::write(repo.path().join("new file"), "next").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "--quiet", "-m", "next"]);
    let next = git(repo.path(), &["rev-parse", "HEAD"]);
    assert_ne!(old, next);
    let (one, two) = tokio::join!(
        PreparedWorktree::create(repo.path(), parent.path(), Uuid::new_v4()),
        PreparedWorktree::create(repo.path(), parent.path(), Uuid::new_v4()),
    );
    let (one, two) = (one.unwrap(), two.unwrap());
    assert_ne!(one.metadata.root, two.metadata.root);
    assert_eq!(git(&one.metadata.root, &["rev-parse", "HEAD"]), next);
    assert_eq!(git(&two.metadata.root, &["rev-parse", "HEAD"]), next);
}

#[tokio::test]
async fn deletes_dirty_and_untracked_files_only_in_the_owned_checkout() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![prepared_codex()]);
    let draft = threads
        .create_in_worktree(repo.path(), parent.path(), "codex")
        .await
        .unwrap();
    let worktree = draft.worktree.unwrap();
    std::fs::write(worktree.root.join("packages/app/main.ts"), "dirty").unwrap();
    std::fs::write(worktree.root.join("untracked"), "local").unwrap();
    threads.delete(draft.id).await.unwrap();
    assert!(!worktree.root.exists());
    assert_eq!(
        std::fs::read_to_string(repo.path().join("packages/app/main.ts")).unwrap(),
        "committed"
    );
    assert!(threads.list().unwrap().is_empty());
}

#[tokio::test]
async fn preserves_thread_and_checkout_on_removal_failure_then_retries() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![prepared_codex()]);
    let draft = threads
        .create_in_worktree(repo.path(), parent.path(), "codex")
        .await
        .unwrap();
    let worktree = draft.worktree.unwrap();
    git(
        repo.path(),
        &["worktree", "lock", worktree.root.to_str().unwrap()],
    );
    let error = threads.delete(draft.id).await.unwrap_err().to_string();
    assert!(error.contains(worktree.root.to_str().unwrap()));
    assert!(worktree.root.is_dir());
    assert!(threads.get(draft.id).is_ok());
    git(
        repo.path(),
        &["worktree", "unlock", worktree.root.to_str().unwrap()],
    );
    threads.delete(draft.id).await.unwrap();
    assert!(!worktree.root.exists());
}

#[tokio::test]
async fn deleting_a_missing_or_already_pruned_checkout_is_idempotent() {
    for prune in [false, true] {
        let repo = repository();
        let parent = tempfile::tempdir().unwrap();
        let threads = Threads::new(vec![prepared_codex()]);
        let draft = threads
            .create_in_worktree(repo.path(), parent.path(), "codex")
            .await
            .unwrap();
        let worktree = draft.worktree.unwrap();
        std::fs::remove_dir_all(&worktree.root).unwrap();
        if prune {
            git(repo.path(), &["worktree", "prune", "--expire", "now"]);
        }
        threads.delete(draft.id).await.unwrap();
        assert!(threads.get(draft.id).is_err());
        assert!(!worktree.root.parent().unwrap().exists());
    }
}

#[tokio::test]
async fn retries_record_deletion_after_checkout_removal_and_database_failure() {
    let repo = repository();
    let data = tempfile::tempdir().unwrap();
    let db_path = data.path().join("atte.sqlite");
    let store = Arc::new(Store::open(&db_path).unwrap());
    let threads = Threads::with_store(vec![prepared_codex()], store).unwrap();
    let draft = threads
        .create_in_worktree(repo.path(), &data.path().join("worktrees"), "codex")
        .await
        .unwrap();
    let database = rusqlite::Connection::open(db_path).unwrap();
    database.execute_batch("CREATE TRIGGER reject_delete BEFORE DELETE ON threads BEGIN SELECT RAISE(ABORT, 'rejected'); END;").unwrap();
    assert!(threads.delete(draft.id).await.is_err());
    assert!(threads.get(draft.id).is_ok());
    assert!(!draft.worktree.unwrap().root.exists());
    database
        .execute_batch("DROP TRIGGER reject_delete;")
        .unwrap();
    threads.delete(draft.id).await.unwrap();
    assert!(threads.list().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn refuses_removal_if_the_owned_worktree_path_is_replaced_with_a_symlink() {
    use std::os::unix::fs::symlink;
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![prepared_codex()]);
    let draft = threads
        .create_in_worktree(repo.path(), parent.path(), "codex")
        .await
        .unwrap();
    let worktree = draft.worktree.unwrap();
    std::fs::remove_dir_all(&worktree.root).unwrap();
    symlink(repo.path(), &worktree.root).unwrap();
    assert!(threads.delete(draft.id).await.is_err());
    assert!(threads.get(draft.id).is_ok());
    assert!(repo.path().join(".git").is_dir());
}

#[cfg(unix)]
#[tokio::test]
async fn refuses_a_committed_subfolder_symlink_that_escapes_the_checkout() {
    use std::os::unix::fs::symlink;
    let repo = repository();
    let outside = tempfile::tempdir().unwrap();
    let selected = repo.path().join("packages/app");
    std::fs::remove_dir_all(&selected).unwrap();
    symlink(outside.path(), &selected).unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "--quiet", "-m", "external link"]);
    // The selected directory exists locally, while HEAD will restore an external symlink.
    std::fs::remove_file(&selected).unwrap();
    std::fs::create_dir(&selected).unwrap();
    let parent = tempfile::tempdir().unwrap();
    let result = PreparedWorktree::create(&selected, parent.path(), Uuid::new_v4()).await;
    assert!(
        result.is_err(),
        "an agent must never run outside its isolated checkout"
    );
    assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn refuses_reconnection_when_a_checkout_subfolder_becomes_an_external_symlink() {
    use std::os::unix::fs::symlink;
    let repo = repository();
    let outside = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![prepared_codex()]);
    let draft = threads
        .create_in_worktree(&repo.path().join("packages/app"), parent.path(), "codex")
        .await
        .unwrap();
    std::fs::remove_dir_all(&draft.working_folder).unwrap();
    symlink(outside.path(), &draft.working_folder).unwrap();
    assert!(
        threads.connect(draft.id).is_err(),
        "reconnection must reject an external cwd"
    );
}

#[tokio::test]
async fn deletes_threads_despite_finder_metadata_in_the_uuid_container() {
    for already_removed in [false, true] {
        let repo = repository();
        let data = tempfile::tempdir().unwrap();
        let database = data.path().join("atte.sqlite");
        let store = Arc::new(Store::open(&database).unwrap());
        let threads = Threads::with_store(vec![prepared_codex()], store).unwrap();
        let draft = threads
            .create_in_worktree(repo.path(), &data.path().join("worktrees"), "codex")
            .await
            .unwrap();
        let worktree = draft.worktree.unwrap();
        let container = worktree.root.parent().unwrap();
        std::fs::write(container.join(".DS_Store"), "Finder metadata").unwrap();
        if already_removed {
            // Reproduce retry after Git removal succeeded but container cleanup failed.
            git(
                repo.path(),
                &[
                    "worktree",
                    "remove",
                    "--force",
                    worktree.root.to_str().unwrap(),
                ],
            );
        }
        drop(threads);
        let restored = Threads::with_store(
            vec![prepared_codex()],
            Arc::new(Store::open(&database).unwrap()),
        )
        .unwrap();
        restored.delete(draft.id).await.unwrap();
        assert!(!worktree.root.exists());
        assert!(!container.exists());
        assert!(restored.list().unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(repo.path().join("packages/app/main.ts")).unwrap(),
            "committed"
        );
    }
}

#[tokio::test]
async fn preserves_other_container_files_without_failing_checkout_deletion() {
    let repo = repository();
    let parent = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![prepared_codex()]);
    let draft = threads
        .create_in_worktree(repo.path(), parent.path(), "codex")
        .await
        .unwrap();
    let worktree = draft.worktree.unwrap();
    let retained = worktree.root.parent().unwrap().join("notes.txt");
    std::fs::write(&retained, "keep outside checkout").unwrap();
    threads.delete(draft.id).await.unwrap();
    assert!(!worktree.root.exists());
    assert!(threads.list().unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(retained).unwrap(),
        "keep outside checkout"
    );
}
