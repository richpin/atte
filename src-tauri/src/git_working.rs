//! Working-tree status and narrow Git mutations for a thread's repository.
use crate::{git, thread::Threads};
use serde::Serialize;
use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    os::unix::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tauri::State;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_PATCH: usize = 2 * 1024 * 1024;
static MUTATION: OnceLock<Mutex<()>> = OnceLock::new();
fn mutation() -> &'static Mutex<()> {
    MUTATION.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub(crate) enum Error {
    #[error("The working folder is not a Git repository")]
    NotRepository,
    #[error("The thread is unavailable")]
    Unavailable,
    #[error("The selected file or Git state changed; refresh and try again")]
    Stale,
    #[error("A merge or other Git operation requires attention")]
    InProgress,
    #[error("Invalid Git request")]
    Invalid,
    #[error("Git: {0}")]
    Git(String),
}
impl From<git::Error> for Error {
    fn from(value: git::Error) -> Self {
        Self::Git(value.to_string())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct File {
    id: String,
    path: String,
    old_path: Option<String>,
    old_id: Option<String>,
    status: String,
    staged: bool,
    unstaged: bool,
    conflict: bool,
    submodule: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    root: PathBuf,
    branch: Option<String>,
    head: Option<String>,
    index_tree: Option<String>,
    operation: Option<String>,
    files: Vec<File>,
}
#[derive(Serialize)]
#[serde(tag = "kind", content = "patch", rename_all = "camelCase")]
pub(crate) enum Patch {
    Text(String),
    Binary,
    TooLarge,
    Unsupported,
    Submodule,
}

fn encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn decode(id: &str) -> Result<Vec<u8>, Error> {
    if !id.len().is_multiple_of(2) || id.is_empty() {
        return Err(Error::Invalid);
    }
    (0..id.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&id[i..i + 2], 16).map_err(|_| Error::Invalid))
        .collect()
}
fn display(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
fn literal_path(id: &str) -> Result<Vec<u8>, Error> {
    let mut path = b":(literal)".to_vec();
    path.extend(decode(id)?);
    Ok(path)
}
async fn run(root: &Path, args: &[&OsStr]) -> Result<Vec<u8>, Error> {
    Ok(git::run(root, args).await?)
}
async fn root(threads: &Threads, thread_id: Uuid) -> Result<PathBuf, Error> {
    let folder = threads
        .get(thread_id)
        .map_err(|_| Error::Unavailable)?
        .working_folder;
    match run(
        &folder,
        &[OsStr::new("rev-parse"), OsStr::new("--show-toplevel")],
    )
    .await
    {
        Ok(bytes) => Ok(PathBuf::from(OsString::from_vec(
            bytes.trim_ascii_end().to_vec(),
        ))),
        Err(Error::Git(_)) => Err(Error::NotRepository),
        Err(error) => Err(error),
    }
}
async fn optional(root: &Path, args: &[&OsStr]) -> Option<String> {
    run(root, args)
        .await
        .ok()
        .map(|bytes| display(bytes.trim_ascii_end()))
}
async fn read_patch(
    root: &Path,
    args: &[&OsStr],
    allow_diff_exit: bool,
) -> Result<Option<Vec<u8>>, Error> {
    let mut child = git::spawn(root, args)?;
    drop(child.stdin.take());
    let mut stdout = child.stdout.take().ok_or(Error::Unavailable)?;
    let mut stderr = child.stderr.take().ok_or(Error::Unavailable)?;
    let errors = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    });
    let mut bytes = Vec::new();
    (&mut stdout)
        .take((MAX_PATCH + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| Error::Git(e.to_string()))?;
    if bytes.len() > MAX_PATCH {
        child.kill().await.map_err(|e| Error::Git(e.to_string()))?;
        errors.abort();
        return Ok(None);
    }
    let status = child.wait().await.map_err(|e| Error::Git(e.to_string()))?;
    let error_bytes = errors
        .await
        .map_err(|e| Error::Git(e.to_string()))?
        .map_err(|e| Error::Git(e.to_string()))?;
    if !status.success() && !(allow_diff_exit && status.code() == Some(1)) {
        return Err(Error::Git(display(&error_bytes)));
    }
    Ok(Some(bytes))
}
async fn operation(root: &Path) -> Result<Option<String>, Error> {
    let git_dir = run(
        root,
        &[OsStr::new("rev-parse"), OsStr::new("--absolute-git-dir")],
    )
    .await?;
    let dir = PathBuf::from(OsString::from_vec(git_dir.trim_ascii_end().to_vec()));
    for (name, label) in [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
    ] {
        if dir.join(name).exists() {
            return Ok(Some(label.into()));
        }
    }
    Ok(None)
}
fn parse_status(bytes: &[u8]) -> Result<Vec<File>, Error> {
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 || record[2] != b' ' {
            return Err(Error::Git("Invalid Git status record".into()));
        }
        let x = record[0];
        let y = record[1];
        let path = &record[3..];
        let renamed = matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C');
        let old = if renamed {
            Some(records.next().ok_or(Error::Stale)?)
        } else {
            None
        };
        let conflict =
            x == b'U' || y == b'U' || (x == b'A' && y == b'A') || (x == b'D' && y == b'D');
        files.push(File {
            id: encode(path),
            path: display(path),
            old_path: old.map(display),
            old_id: old.map(encode),
            status: String::from_utf8_lossy(&record[..2]).into_owned(),
            staged: x != b' ' && x != b'?' && !conflict,
            unstaged: y != b' ' && !conflict,
            conflict,
            submodule: false,
        });
    }
    Ok(files)
}
async fn snapshot(root: &Path) -> Result<Snapshot, Error> {
    let status = run(
        root,
        &[
            OsStr::new("status"),
            OsStr::new("--porcelain=v1"),
            OsStr::new("-z"),
            OsStr::new("--untracked-files=all"),
        ],
    )
    .await?;
    let mut files = parse_status(&status)?;
    let index = run(
        root,
        &[
            OsStr::new("ls-files"),
            OsStr::new("--stage"),
            OsStr::new("-z"),
        ],
    )
    .await?;
    let submodules: HashSet<Vec<u8>> = index
        .split(|byte| *byte == 0)
        .filter_map(|entry| entry.strip_prefix(b"160000 "))
        .filter_map(|entry| {
            entry
                .splitn(2, |byte| *byte == b'\t')
                .nth(1)
                .map(<[u8]>::to_vec)
        })
        .collect();
    for file in &mut files {
        file.submodule = submodules.contains(&decode(&file.id)?);
    }
    Ok(Snapshot {
        root: root.to_path_buf(),
        branch: optional(
            root,
            &[
                OsStr::new("symbolic-ref"),
                OsStr::new("--quiet"),
                OsStr::new("--short"),
                OsStr::new("HEAD"),
            ],
        )
        .await,
        head: optional(
            root,
            &[
                OsStr::new("rev-parse"),
                OsStr::new("--verify"),
                OsStr::new("HEAD"),
            ],
        )
        .await,
        index_tree: optional(root, &[OsStr::new("write-tree")]).await,
        operation: operation(root).await?,
        files,
    })
}
#[tauri::command]
pub(crate) async fn read_git_working_changes(
    threads: State<'_, Threads>,
    thread_id: Uuid,
) -> Result<Snapshot, Error> {
    snapshot(&root(&threads, thread_id).await?).await
}
#[tauri::command]
pub(crate) async fn read_git_working_file(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    file_id: String,
    side: String,
) -> Result<Patch, Error> {
    if side != "staged" && side != "unstaged" {
        return Err(Error::Invalid);
    }
    let root = root(&threads, thread_id).await?;
    let status = snapshot(&root).await?;
    let file = status
        .files
        .iter()
        .find(|file| file.id == file_id)
        .ok_or(Error::Stale)?;
    if file.conflict || (side == "staged" && !file.staged) || (side == "unstaged" && !file.unstaged)
    {
        return Err(Error::Stale);
    }
    if file.submodule {
        return Ok(Patch::Submodule);
    }
    let path = decode(&file_id)?;
    let path = OsStr::from_bytes(&path);
    let patch = if file.status == "??" {
        // --no-index returns 1 when files differ. Its output is still the expected patch.
        let full_path = root.join(path);
        read_patch(
            &root,
            &[
                OsStr::new("diff"),
                OsStr::new("--no-index"),
                OsStr::new("--no-ext-diff"),
                OsStr::new("--no-textconv"),
                OsStr::new("--no-color"),
                OsStr::new("--"),
                OsStr::new("/dev/null"),
                full_path.as_os_str(),
            ],
            true,
        )
        .await?
    } else {
        let mut args: Vec<&OsStr> = vec![
            OsStr::new("diff"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--no-textconv"),
            OsStr::new("--no-color"),
            OsStr::new("--binary"),
            OsStr::new("-M"),
        ];
        if side == "staged" {
            args.push(OsStr::new("--cached"));
        }
        let literal = literal_path(&file_id)?;
        args.extend([OsStr::new("--"), OsStr::from_bytes(&literal)]);
        let old_literal = file.old_id.as_deref().map(literal_path).transpose()?;
        if let Some(old_literal) = &old_literal {
            args.push(OsStr::from_bytes(old_literal));
        }
        read_patch(&root, &args, false).await?
    };
    let Some(patch) = patch else {
        return Ok(Patch::TooLarge);
    };
    if patch.windows(16).any(|part| part == b"GIT binary patch")
        || patch.windows(12).any(|part| part == b"Binary files")
    {
        return Ok(Patch::Binary);
    }
    String::from_utf8(patch)
        .map(Patch::Text)
        .map_err(|_| Error::Invalid)
        .or(Ok(Patch::Unsupported))
}
async fn change_files(
    threads: &Threads,
    thread_id: Uuid,
    file_ids: Vec<String>,
    all: bool,
    stage: bool,
) -> Result<Snapshot, Error> {
    let root = root(threads, thread_id).await?;
    change_files_at(&root, file_ids, all, stage).await
}
async fn change_files_at(
    root: &Path,
    file_ids: Vec<String>,
    all: bool,
    stage: bool,
) -> Result<Snapshot, Error> {
    let _guard = mutation().lock().await;
    let current = snapshot(root).await?;
    if current.operation.is_some() || current.files.iter().any(|file| file.conflict) {
        return Err(Error::InProgress);
    }
    let selected: Vec<_> = if all {
        current
            .files
            .iter()
            .filter(|file| if stage { file.unstaged } else { file.staged })
            .collect()
    } else {
        if file_ids.is_empty() {
            return Err(Error::Invalid);
        }
        let mut seen = HashSet::new();
        file_ids
            .iter()
            .map(|id| {
                if !seen.insert(id) {
                    return Err(Error::Invalid);
                }
                current
                    .files
                    .iter()
                    .find(|file| file.id == *id && if stage { file.unstaged } else { file.staged })
                    .ok_or(Error::Stale)
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    if selected.is_empty() {
        return Err(Error::Stale);
    }
    for file in selected {
        let mut paths = vec![literal_path(&file.id)?];
        if let Some(old_id) = &file.old_id {
            paths.push(literal_path(old_id)?);
        }
        let names: Vec<_> = paths.iter().map(|path| OsStr::from_bytes(path)).collect();
        if stage {
            let mut args = vec![OsStr::new("add"), OsStr::new("-A"), OsStr::new("--")];
            args.extend(names.iter().copied());
            run(root, &args).await?;
        } else if current.head.is_some() {
            let mut args = vec![
                OsStr::new("restore"),
                OsStr::new("--staged"),
                OsStr::new("--"),
            ];
            args.extend(names.iter().copied());
            run(root, &args).await?;
        } else {
            let mut args = vec![
                OsStr::new("rm"),
                OsStr::new("--cached"),
                OsStr::new("-r"),
                OsStr::new("--ignore-unmatch"),
                OsStr::new("--"),
            ];
            args.extend(names.iter().copied());
            run(root, &args).await?;
        }
    }
    snapshot(root).await
}
#[tauri::command]
pub(crate) async fn stage_git_files(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    file_ids: Vec<String>,
    all: bool,
) -> Result<Snapshot, Error> {
    change_files(&threads, thread_id, file_ids, all, true).await
}
#[tauri::command]
pub(crate) async fn unstage_git_files(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    file_ids: Vec<String>,
    all: bool,
) -> Result<Snapshot, Error> {
    change_files(&threads, thread_id, file_ids, all, false).await
}
#[tauri::command]
pub(crate) async fn commit_git_changes(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    message: String,
    expected_head: Option<String>,
    expected_index_tree: String,
) -> Result<Snapshot, Error> {
    let root = root(&threads, thread_id).await?;
    commit_at(&root, message, expected_head, expected_index_tree).await
}
async fn commit_at(
    root: &Path,
    message: String,
    expected_head: Option<String>,
    expected_index_tree: String,
) -> Result<Snapshot, Error> {
    if message
        .lines()
        .next()
        .is_none_or(|line| line.trim().is_empty())
    {
        return Err(Error::Invalid);
    }
    let _guard = mutation().lock().await;
    let current = snapshot(root).await?;
    if current.operation.is_some() || current.files.iter().any(|file| file.conflict) {
        return Err(Error::InProgress);
    }
    if current.head != expected_head || current.index_tree.as_deref() != Some(&expected_index_tree)
    {
        return Err(Error::Stale);
    }
    if !current.files.iter().any(|file| file.staged) {
        return Err(Error::Invalid);
    }
    run(
        root,
        &[OsStr::new("commit"), OsStr::new("-m"), OsStr::new(&message)],
    )
    .await?;
    snapshot(root).await
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn git(root: &Path, args: &[&str]) -> Vec<u8> {
        let args: Vec<_> = args.iter().map(OsStr::new).collect();
        run(root, &args).await.unwrap()
    }
    async fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]).await;
        git(dir.path(), &["config", "user.name", "Atte Test"]).await;
        git(dir.path(), &["config", "user.email", "atte@example.test"]).await;
        dir
    }
    #[test]
    fn status_tracks_both_sides_and_unusual_names() {
        let bytes = b"MM weird\nname\0?? new file\0";
        let files = parse_status(bytes).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files[0].staged && files[0].unstaged);
        assert_eq!(decode(&files[0].id).unwrap(), b"weird\nname");
        assert!(files[1].unstaged && !files[1].staged);
    }
    #[tokio::test]
    async fn stage_unstage_and_commit_preserve_unstaged_work() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("first"), "one\n").unwrap();
        let first = snapshot(root).await.unwrap();
        assert_eq!(first.files[0].status, "??");
        let staged = change_files_at(root, vec![first.files[0].id.clone()], false, true)
            .await
            .unwrap();
        assert!(staged.files[0].staged);
        let reset = change_files_at(root, vec![staged.files[0].id.clone()], false, false)
            .await
            .unwrap();
        assert!(!reset.files[0].staged);
        let staged = change_files_at(root, vec![], true, true).await.unwrap();
        let committed = commit_at(
            root,
            "feat: first".into(),
            staged.head.clone(),
            staged.index_tree.clone().unwrap(),
        )
        .await
        .unwrap();
        assert!(committed.files.is_empty());
        std::fs::write(root.join("first"), "two\n").unwrap();
        let staged = change_files_at(root, vec![], true, true).await.unwrap();
        std::fs::write(root.join("first"), "three\n").unwrap();
        let partial = snapshot(root).await.unwrap();
        assert!(partial.files[0].staged && partial.files[0].unstaged);
        let committed = commit_at(
            root,
            "fix: staged only".into(),
            staged.head,
            staged.index_tree.unwrap(),
        )
        .await
        .unwrap();
        assert!(committed.files[0].unstaged && !committed.files[0].staged);
        assert_eq!(std::fs::read(root.join("first")).unwrap(), b"three\n");
    }
    #[tokio::test]
    async fn rejects_stale_commit_and_paths_outside_status() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("file"), "one\n").unwrap();
        let staged = change_files_at(root, vec![], true, true).await.unwrap();
        std::fs::write(root.join("other"), "two\n").unwrap();
        change_files_at(root, vec![], true, true).await.unwrap();
        let failed = commit_at(
            root,
            "feat: stale".into(),
            staged.head,
            staged.index_tree.unwrap(),
        )
        .await;
        assert!(matches!(failed, Err(Error::Stale)));
        assert!(matches!(
            change_files_at(root, vec![encode(b"../outside")], false, true).await,
            Err(Error::Stale)
        ));
    }
    #[tokio::test]
    async fn rename_staging_and_unstaging_handle_both_paths() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("before"), "content\n").unwrap();
        git(root, &["add", "before"]).await;
        git(root, &["commit", "-qm", "feat: initial"]).await;
        std::fs::rename(root.join("before"), root.join("after")).unwrap();
        let unstaged = snapshot(root).await.unwrap();
        assert_eq!(unstaged.files.len(), 2);
        let staged = change_files_at(root, vec![], true, true).await.unwrap();
        assert_eq!(staged.files.len(), 1);
        assert_eq!(staged.files[0].path, "after");
        assert_eq!(staged.files[0].old_path.as_deref(), Some("before"));
        assert!(staged.files[0].staged);
        let reset = change_files_at(root, vec![staged.files[0].id.clone()], false, false)
            .await
            .unwrap();
        assert!(!reset.files.iter().any(|file| file.staged));
        assert!(root.join("after").exists());
    }
    #[tokio::test]
    async fn failed_hook_keeps_index_and_message_uncommitted() {
        use std::os::unix::fs::PermissionsExt;
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("file"), "content\n").unwrap();
        let staged = change_files_at(root, vec![], true, true).await.unwrap();
        let hook = root.join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = commit_at(
            root,
            "feat: blocked".into(),
            staged.head,
            staged.index_tree.unwrap(),
        )
        .await;
        assert!(matches!(result, Err(Error::Git(_))));
        assert!(snapshot(root).await.unwrap().files[0].staged);
    }
    #[tokio::test]
    async fn merge_conflict_disables_mutations() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("file"), "base\n").unwrap();
        git(root, &["add", "file"]).await;
        git(root, &["commit", "-qm", "feat: base"]).await;
        git(root, &["checkout", "-qb", "other"]).await;
        std::fs::write(root.join("file"), "other\n").unwrap();
        git(root, &["commit", "-qam", "feat: other"]).await;
        git(root, &["checkout", "-"]).await;
        std::fs::write(root.join("file"), "main\n").unwrap();
        git(root, &["commit", "-qam", "feat: main"]).await;
        let args: Vec<_> = ["merge", "other"].into_iter().map(OsStr::new).collect();
        assert!(crate::git::run(root, &args).await.is_err());
        let state = snapshot(root).await.unwrap();
        assert_eq!(state.operation.as_deref(), Some("merge"));
        assert!(state.files[0].conflict);
        assert!(matches!(
            change_files_at(root, vec![], true, true).await,
            Err(Error::InProgress)
        ));
    }
    #[tokio::test]
    async fn literal_pathspec_names_remain_exact() {
        let dir = repo().await;
        let root = dir.path();
        let unusual = OsStr::from_bytes(b"[abc]*");
        std::fs::write(root.join(unusual), "content\n").unwrap();
        let state = snapshot(root).await.unwrap();
        assert_eq!(decode(&state.files[0].id).unwrap(), unusual.as_bytes());
        let staged = change_files_at(root, vec![state.files[0].id.clone()], false, true)
            .await
            .unwrap();
        assert!(staged.files[0].staged);
        let reset = change_files_at(root, vec![staged.files[0].id.clone()], false, false)
            .await
            .unwrap();
        assert!(reset.files[0].unstaged);
        assert_eq!(std::fs::read(root.join(unusual)).unwrap(), b"content\n");
    }
    #[tokio::test]
    async fn linked_worktree_has_its_own_branch_and_index() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("file"), "base\n").unwrap();
        git(root, &["add", "file"]).await;
        git(root, &["commit", "-qm", "feat: base"]).await;
        let holder = tempfile::tempdir().unwrap();
        let linked = holder.path().join("linked");
        run(
            root,
            &[
                OsStr::new("worktree"),
                OsStr::new("add"),
                OsStr::new("-qb"),
                OsStr::new("linked"),
                linked.as_os_str(),
            ],
        )
        .await
        .unwrap();
        std::fs::write(linked.join("file"), "linked\n").unwrap();
        let state = snapshot(&linked).await.unwrap();
        assert_eq!(state.branch.as_deref(), Some("linked"));
        let staged = change_files_at(&linked, vec![], true, true).await.unwrap();
        assert!(staged.files[0].staged);
        assert!(snapshot(root).await.unwrap().files.is_empty());
    }
}
