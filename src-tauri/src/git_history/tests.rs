use super::*;
use std::{collections::HashSet, fs};

async fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let mut options = vec![
        "-c",
        "user.name=History Fixture",
        "-c",
        "user.email=history@example.invalid",
        "-c",
        "commit.gpgsign=false",
    ];
    options.extend(args);
    run(root, &options).await.unwrap()
}
async fn init() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q", "-b", "main"]).await;
    temp
}
async fn commit(root: &Path, message: &str) -> String {
    git(root, &["add", "-A"]).await;
    git(root, &["commit", "-q", "--allow-empty", "-m", message]).await;
    text(&git(root, &["rev-parse", "HEAD"]).await).trim().into()
}

#[tokio::test]
async fn pages_stream_a_fixed_snapshot_without_duplicates() {
    let temp = init().await;
    let root = temp.path();
    let tree = text(&git(root, &["write-tree"]).await).trim().to_owned();
    let mut parent = String::new();
    for index in 0..405 {
        let message = format!("commit {index}");
        let mut args = vec!["commit-tree", &tree, "-m", &message];
        if !parent.is_empty() {
            args.extend(["-p", &parent]);
        }
        parent = text(&git(root, &args).await).trim().into();
    }
    git(root, &["update-ref", "refs/heads/main", &parent]).await;
    let mut walk = Walk::start(root, &[parent.clone()]).await.unwrap();
    let cursor = Uuid::new_v4();
    let first = walk.page(cursor).await.unwrap();
    assert_eq!(first.commits.len(), 200);
    assert_eq!(first.cursor, Some(cursor));
    // Moving a ref while reading must not change the already-started traversal.
    commit(root, "new external commit").await;
    let second = walk.page(cursor).await.unwrap();
    let last = walk.page(cursor).await.unwrap();
    assert_eq!(second.commits.len(), 200);
    assert_eq!(last.commits.len(), 5);
    assert_eq!(last.cursor, None);
    let commits: Vec<_> = first
        .commits
        .into_iter()
        .chain(second.commits)
        .chain(last.commits)
        .collect();
    assert_eq!(commits.first().unwrap().oid, parent);
    assert_eq!(
        commits
            .iter()
            .map(|commit| &commit.oid)
            .collect::<HashSet<_>>()
            .len(),
        405
    );
}

#[tokio::test]
async fn branch_walk_includes_shared_ancestors_and_only_its_reachable_commits() {
    let temp = init().await;
    let root = temp.path();
    let common = commit(root, "common").await;
    git(root, &["checkout", "-q", "-b", "feature"]).await;
    let feature = commit(root, "feature").await;
    git(root, &["checkout", "-q", "main"]).await;
    commit(root, "main only").await;
    git(root, &["tag", "-a", "v1", &common, "-m", "release"]).await;
    let repo = repository(root).await.unwrap();
    assert!(repo
        .references
        .iter()
        .any(|reference| reference.kind == "tag" && reference.oid == common));
    let mut walk = Walk::start(root, std::slice::from_ref(&feature))
        .await
        .unwrap();
    let page = walk.page(Uuid::new_v4()).await.unwrap();
    assert_eq!(
        page.commits
            .into_iter()
            .map(|commit| commit.oid)
            .collect::<Vec<_>>(),
        [feature, common]
    );
    assert_eq!(
        text(&git(root, &["branch", "--show-current"]).await).trim(),
        "main"
    );
}

#[tokio::test]
async fn merge_diff_uses_first_parent_and_root_commit_compares_to_empty_tree() {
    let temp = init().await;
    let root = temp.path();
    fs::write(root.join("initial.txt"), "initial\n").unwrap();
    let initial = commit(root, "root").await;
    let first = details_with_stats(root, &initial).await.unwrap();
    assert_eq!(
        (first.files[0].additions, first.files[0].deletions),
        (Some(1), Some(0))
    );
    assert!(first.base.is_none());
    assert_eq!(first.files[0].change, "A");
    assert!(
        matches!(patch(root, &initial, 0).await.unwrap(), FilePatch::Text(patch) if patch.contains("+initial"))
    );
    git(root, &["checkout", "-q", "-b", "feature"]).await;
    fs::write(root.join("feature.txt"), "feature\n").unwrap();
    commit(root, "feature").await;
    git(root, &["checkout", "-q", "main"]).await;
    fs::write(root.join("main.txt"), "main\n").unwrap();
    let main = commit(root, "main").await;
    git(root, &["merge", "--no-ff", "-m", "merge", "feature"]).await;
    let oid = text(&git(root, &["rev-parse", "HEAD"]).await)
        .trim()
        .to_owned();
    let result = details_with_stats(root, &oid).await.unwrap();
    assert_eq!(result.base.as_deref(), Some(main.as_str()));
    assert_eq!(result.commit.parents.len(), 2);
    assert_eq!(result.files.len(), 1);
    assert_eq!(result.files[0].path, "feature.txt");
    assert_eq!(
        (result.files[0].additions, result.files[0].deletions),
        (Some(1), Some(0))
    );
}

#[tokio::test]
async fn preserves_renames_unusual_paths_binary_and_mode_only_changes() {
    use std::os::unix::fs::PermissionsExt;
    let temp = init().await;
    let root = temp.path();
    fs::write(root.join("before.txt"), "unchanged content\n").unwrap();
    fs::write(root.join("script"), "run\n").unwrap();
    commit(root, "initial").await;
    let name = ":(glob)*\t\"한글\n.txt";
    fs::rename(root.join("before.txt"), root.join(name)).unwrap();
    fs::write(root.join("image.bin"), b"\0\x01\xff").unwrap();
    fs::set_permissions(root.join("script"), fs::Permissions::from_mode(0o755)).unwrap();
    let oid = commit(root, "rename and binary").await;
    let result = details_with_stats(root, &oid).await.unwrap();
    let (index, renamed) = result
        .files
        .iter()
        .enumerate()
        .find(|(_, file)| file.old_path.is_some())
        .unwrap();
    assert_eq!(renamed.path, name);
    assert_eq!((renamed.additions, renamed.deletions), (Some(0), Some(0)));
    assert_eq!(renamed.old_path.as_deref(), Some("before.txt"));
    assert!(
        matches!(patch(root, &oid, index).await.unwrap(), FilePatch::Text(patch) if patch.contains("similarity index 100%"))
    );
    let index = result
        .files
        .iter()
        .position(|file| file.path == "image.bin")
        .unwrap();
    assert_eq!(
        (result.files[index].additions, result.files[index].deletions),
        (None, None)
    );
    assert!(matches!(
        patch(root, &oid, index).await.unwrap(),
        FilePatch::Binary
    ));
    let index = result
        .files
        .iter()
        .position(|file| file.path == "script")
        .unwrap();
    assert_eq!(
        (result.files[index].additions, result.files[index].deletions),
        (Some(0), Some(0))
    );
    assert!(
        matches!(patch(root, &oid, index).await.unwrap(), FilePatch::Text(patch) if patch.contains("new mode 100755"))
    );
}

#[tokio::test]
async fn empty_repo_detached_head_and_linked_worktree_are_supported() {
    let temp = init().await;
    assert!(repository(temp.path()).await.unwrap().head.is_none());
    let oid = commit(temp.path(), "root").await;
    git(temp.path(), &["checkout", "-q", "--detach"]).await;
    assert_eq!(
        repository(temp.path()).await.unwrap().head.as_deref(),
        Some(oid.as_str())
    );
    let linked = tempfile::tempdir().unwrap();
    let target = linked.path().join("checkout");
    git(
        temp.path(),
        &[
            "worktree",
            "add",
            "--detach",
            target.to_str().unwrap(),
            &oid,
        ],
    )
    .await;
    fs::create_dir(target.join("nested")).unwrap();
    let repo = repository(&target.join("nested")).await.unwrap();
    assert_eq!(
        repo.root.canonicalize().unwrap(),
        target.canonicalize().unwrap()
    );
}

#[tokio::test]
async fn validates_object_ids_and_bounds_large_file_diffs() {
    let temp = init().await;
    assert!(matches!(
        details(temp.path(), "--output=/tmp/invalid").await,
        Err(HistoryError::InvalidRequest)
    ));
    fs::write(temp.path().join("large"), vec![b'x'; MAX_PATCH_BYTES + 1]).unwrap();
    let oid = commit(temp.path(), "large").await;
    let result = details_with_stats(temp.path(), &oid).await.unwrap();
    assert_eq!(
        (result.files[0].additions, result.files[0].deletions),
        (Some(1), Some(0))
    );
    assert!(matches!(
        patch(temp.path(), &oid, 0).await.unwrap(),
        FilePatch::TooLarge
    ));
}

#[tokio::test]
async fn shallow_boundary_is_not_reported_as_an_initial_commit() {
    let source = init().await;
    commit(source.path(), "root").await;
    let tip = commit(source.path(), "tip").await;
    let cloned = tempfile::tempdir().unwrap();
    let target = cloned.path().join("clone");
    git(
        cloned.path(),
        &[
            "clone",
            "--depth=1",
            &format!("file://{}", source.path().display()),
            target.to_str().unwrap(),
        ],
    )
    .await;
    assert!(repository(&target).await.unwrap().shallow);
    let result = details_with_stats(&target, &tip).await.unwrap();
    assert!(result.boundary);
    assert!(result.base.is_some());
    assert!(result.files.is_empty());
}

#[tokio::test]
async fn submodule_changes_expose_both_object_ids_without_reading_them_as_blobs() {
    let temp = init().await;
    let root = temp.path();
    let first = commit(root, "root").await;
    git(
        root,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{first},module"),
        ],
    )
    .await;
    git(root, &["commit", "-q", "-m", "add submodule"]).await;
    let second = text(&git(root, &["rev-parse", "HEAD"]).await)
        .trim()
        .to_owned();
    git(
        root,
        &[
            "update-index",
            "--cacheinfo",
            &format!("160000,{second},module"),
        ],
    )
    .await;
    git(root, &["commit", "-q", "-m", "update submodule"]).await;
    let oid = text(&git(root, &["rev-parse", "HEAD"]).await)
        .trim()
        .to_owned();
    let result = details_with_stats(root, &oid).await.unwrap();
    assert_eq!(result.files[0].old_oid, first);
    assert_eq!(result.files[0].new_oid, second);
    assert!(matches!(
        patch(root, &oid, 0).await.unwrap(),
        FilePatch::Submodule
    ));
}

#[tokio::test]
async fn line_statistics_match_raw_paths_for_additions_deletions_and_edits() {
    let temp = init().await;
    let root = temp.path();
    let unusual = "tab\tand\nnewline.txt";
    fs::write(root.join(unusual), "one\ntwo\nthree\n").unwrap();
    fs::write(root.join("deleted"), "removed\n").unwrap();
    commit(root, "initial").await;
    fs::write(root.join(unusual), "one\nchanged\nthree\nextra\n").unwrap();
    fs::remove_file(root.join("deleted")).unwrap();
    fs::write(root.join("added"), "new\nfile\n").unwrap();
    let oid = commit(root, "changes").await;
    let result = details_with_stats(root, &oid).await.unwrap();
    let counts: HashMap<_, _> = result
        .files
        .iter()
        .map(|file| (file.path.as_str(), (file.additions, file.deletions)))
        .collect();
    assert_eq!(
        counts,
        HashMap::from([
            (unusual, (Some(2), Some(1))),
            ("deleted", (Some(0), Some(1))),
            ("added", (Some(2), Some(0))),
        ])
    );
}

#[test]
fn rejects_incomplete_or_mismatched_line_statistics() {
    let raw = b":100644 100644 old new M\0a\0";
    for invalid in [
        b"1\t0\tb\0".as_slice(),
        b"1\t0\0",
        b"-\t1\ta\0",
        b"1\t0\t\0a\0",
        b"1\t0\ta\0\0",
    ] {
        let mut files = parse_files(raw).unwrap();
        assert!(apply_numstat(&mut files, invalid).is_err());
    }
}
