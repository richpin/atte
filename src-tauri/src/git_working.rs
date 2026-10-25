//! Working-tree status and narrow Git mutations for a thread's repository.
use crate::{git, thread::Threads, workspace_files::trash_item};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    io::Read,
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        fs::MetadataExt,
    },
    path::{Component, Path, PathBuf},
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
    exists: bool,
    staged_change: Option<SideChange>,
    unstaged_change: Option<SideChange>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SideChange {
    old_path: Option<String>,
    additions: Option<u64>,
    deletions: Option<u64>,
    revision: String,
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
    revision: String,
    latest_stash: Option<String>,
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
            exists: false,
            staged_change: None,
            unstaged_change: None,
        });
    }
    Ok(files)
}

type LineStats = (Option<Vec<u8>>, Option<u64>, Option<u64>);

fn parse_numstat(bytes: &[u8]) -> Result<HashMap<Vec<u8>, LineStats>, Error> {
    let mut fields = bytes.split(|byte| *byte == 0);
    let mut stats = HashMap::new();
    while let Some(record) = fields.next() {
        if record.is_empty() && fields.clone().next().is_none() {
            break;
        }
        let mut columns = record.splitn(3, |byte| *byte == b'\t');
        let (Some(added), Some(deleted), Some(path)) =
            (columns.next(), columns.next(), columns.next())
        else {
            return Err(Error::Git("Invalid Git line statistics".into()));
        };
        let counts = if added == b"-" && deleted == b"-" {
            (None, None)
        } else {
            let parse = |bytes: &[u8]| {
                std::str::from_utf8(bytes)
                    .ok()
                    .and_then(|text| text.parse().ok())
                    .ok_or_else(|| Error::Git("Invalid Git line statistics".into()))
            };
            (Some(parse(added)?), Some(parse(deleted)?))
        };
        let (old, current) = if path.is_empty() {
            (
                Some(fields.next().ok_or(Error::Stale)?.to_vec()),
                fields.next().ok_or(Error::Stale)?.to_vec(),
            )
        } else {
            (None, path.to_vec())
        };
        if stats.insert(current, (old, counts.0, counts.1)).is_some() {
            return Err(Error::Git("Duplicate Git line statistics".into()));
        }
    }
    Ok(stats)
}

fn untracked_stats(path: &Path) -> Result<(Option<u64>, Option<u64>), Error> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((None, None)),
        Err(error) => return Err(Error::Git(error.to_string())),
    };
    if !metadata.is_file() {
        return Ok((None, None));
    }
    let mut file = std::fs::File::open(path).map_err(|error| Error::Git(error.to_string()))?;
    let mut lines = 0;
    let mut last = None;
    let mut buffer = [0; 65536];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| Error::Git(error.to_string()))?;
        if read == 0 {
            break;
        }
        if buffer[..read].contains(&0) {
            return Ok((None, None));
        }
        lines += buffer[..read].iter().filter(|byte| **byte == b'\n').count() as u64;
        last = Some(buffer[read - 1]);
    }
    if last.is_some_and(|byte| byte != b'\n') {
        lines += 1;
    }
    Ok((Some(lines), Some(0)))
}

fn digest(parts: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    format!("{:x}", hash.finalize())
}

fn file_metadata_revision(path: &Path) -> String {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => format!(
            "{}:{}:{}:{}:{}:{}",
            meta.ino(),
            meta.len(),
            meta.mtime(),
            meta.mtime_nsec(),
            meta.ctime(),
            meta.ctime_nsec()
        ),
        Err(_) => "missing".into(),
    }
}

async fn status_files(root: &Path) -> Result<(Vec<File>, Vec<u8>, Vec<u8>), Error> {
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
        let raw = decode(&file.id)?;
        file.submodule = submodules.contains(&raw);
        file.exists = std::fs::symlink_metadata(root.join(OsStr::from_bytes(&raw))).is_ok();
    }
    Ok((files, status, index))
}

async fn snapshot(root: &Path) -> Result<Snapshot, Error> {
    let (mut files, status, index) = status_files(root).await?;
    let conflicted = files.iter().any(|file| file.conflict);
    let staged_stats = if conflicted {
        HashMap::new()
    } else {
        parse_numstat(
            &run(
                root,
                &[
                    OsStr::new("diff"),
                    OsStr::new("--cached"),
                    OsStr::new("--numstat"),
                    OsStr::new("-z"),
                    OsStr::new("-M"),
                    OsStr::new("--no-ext-diff"),
                    OsStr::new("--no-textconv"),
                ],
            )
            .await?,
        )?
    };
    let unstaged_stats = if conflicted {
        HashMap::new()
    } else {
        parse_numstat(
            &run(
                root,
                &[
                    OsStr::new("diff"),
                    OsStr::new("--numstat"),
                    OsStr::new("-z"),
                    OsStr::new("-M"),
                    OsStr::new("--no-ext-diff"),
                    OsStr::new("--no-textconv"),
                ],
            )
            .await?,
        )?
    };
    let head = optional(
        root,
        &[
            OsStr::new("rev-parse"),
            OsStr::new("--verify"),
            OsStr::new("HEAD"),
        ],
    )
    .await;
    let index_tree = optional(root, &[OsStr::new("write-tree")]).await;
    let latest_stash = optional(
        root,
        &[
            OsStr::new("rev-parse"),
            OsStr::new("--verify"),
            OsStr::new("refs/stash"),
        ],
    )
    .await;
    for file in &mut files {
        let raw = decode(&file.id)?;
        let index_entry = index
            .split(|byte| *byte == 0)
            .find(|entry| entry.splitn(2, |byte| *byte == b'\t').nth(1) == Some(raw.as_slice()))
            .unwrap_or_default();
        if file.staged {
            let stats = staged_stats.get(&raw);
            file.staged_change = Some(SideChange {
                old_path: stats
                    .and_then(|stats| stats.0.as_deref())
                    .map(display)
                    .or_else(|| file.old_path.clone()),
                additions: stats.and_then(|stats| stats.1),
                deletions: stats.and_then(|stats| stats.2),
                revision: digest(&[
                    head.as_deref().unwrap_or("").as_bytes(),
                    index_entry,
                    &file.status.as_bytes()[..1],
                ]),
            });
        }
        if file.unstaged {
            let stats = unstaged_stats.get(&raw);
            let (additions, deletions) = if file.status == "??" {
                untracked_stats(&root.join(OsStr::from_bytes(&raw)))?
            } else {
                (
                    stats.and_then(|stats| stats.1),
                    stats.and_then(|stats| stats.2),
                )
            };
            let metadata = file_metadata_revision(&root.join(OsStr::from_bytes(&raw)));
            file.unstaged_change = Some(SideChange {
                old_path: stats.and_then(|stats| stats.0.as_deref()).map(display),
                additions,
                deletions,
                revision: digest(&[
                    index_entry,
                    metadata.as_bytes(),
                    &file.status.as_bytes()[1..],
                ]),
            });
        }
    }
    let mut revision_parts = vec![
        status.as_slice(),
        index.as_slice(),
        head.as_deref().unwrap_or("").as_bytes(),
    ];
    let metadata_revisions: Vec<String> = files
        .iter()
        .map(|file| {
            file.unstaged_change
                .as_ref()
                .map_or("", |change| change.revision.as_str())
                .to_owned()
        })
        .collect();
    revision_parts.extend(
        metadata_revisions
            .iter()
            .map(|revision| revision.as_bytes()),
    );
    let revision = digest(&revision_parts);
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
        head,
        index_tree,
        operation: operation(root).await?,
        files,
        revision,
        latest_stash,
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
    let (files, _, _) = status_files(&root).await?;
    let file = files
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

fn safe_item(root: &Path, raw: &[u8]) -> Result<PathBuf, Error> {
    let relative = Path::new(OsStr::from_bytes(raw));
    if raw.is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(name) if name != ".git"))
    {
        return Err(Error::Invalid);
    }
    let canonical_root = root.canonicalize().map_err(|_| Error::Stale)?;
    let parent = root
        .join(relative.parent().ok_or(Error::Invalid)?)
        .canonicalize()
        .map_err(|_| Error::Stale)?;
    if !parent.starts_with(&canonical_root)
        || parent
            .strip_prefix(&canonical_root)
            .is_ok_and(|path| path.components().any(|part| part.as_os_str() == ".git"))
    {
        return Err(Error::Invalid);
    }
    Ok(parent.join(relative.file_name().ok_or(Error::Invalid)?))
}

async fn trash_existing(root: &Path, id: &str) -> Result<bool, Error> {
    let path = safe_item(root, &decode(id)?)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(Error::Git(error.to_string())),
    };
    if metadata.is_dir() {
        return Err(Error::Invalid);
    }
    tauri::async_runtime::spawn_blocking(move || trash_item(&path))
        .await
        .map_err(|error| Error::Git(error.to_string()))?
        .map_err(|error| Error::Git(error.to_string()))?;
    Ok(true)
}

async fn selected_files<'a>(
    current: &'a Snapshot,
    ids: &[String],
    all: bool,
    restore: bool,
) -> Result<Vec<&'a File>, Error> {
    if all {
        return Ok(current
            .files
            .iter()
            .filter(|file| !file.conflict && !file.submodule && (!restore || file.status != "??"))
            .collect());
    }
    if ids.is_empty() {
        return Err(Error::Invalid);
    }
    let mut seen = HashSet::new();
    ids.iter()
        .map(|id| {
            if !seen.insert(id) {
                return Err(Error::Invalid);
            }
            current
                .files
                .iter()
                .find(|file| file.id == *id && !file.conflict && (!restore || file.status != "??"))
                .ok_or(Error::Stale)
        })
        .collect()
}

async fn restore_or_trash_at(
    root: &Path,
    ids: Vec<String>,
    all: bool,
    expected_revision: String,
    restore: bool,
) -> Result<Snapshot, Error> {
    let _guard = mutation().lock().await;
    let current = snapshot(root).await?;
    if current.operation.is_some() || current.files.iter().any(|file| file.conflict) {
        return Err(Error::InProgress);
    }
    if current.revision != expected_revision {
        return Err(Error::Stale);
    }
    let selected = selected_files(&current, &ids, all, restore).await?;
    if selected.is_empty() {
        return Err(Error::Stale);
    }
    let mut acted = false;
    for file in selected {
        if file.submodule {
            return Err(Error::Invalid);
        }
        if !restore {
            acted |= trash_existing(root, &file.id).await?;
            continue;
        }
        if file.status.starts_with(['A', 'C']) || current.head.is_none() {
            trash_existing(root, &file.id).await?;
            let literal = literal_path(&file.id)?;
            run(
                root,
                &[
                    OsStr::new("rm"),
                    OsStr::new("--cached"),
                    OsStr::new("-f"),
                    OsStr::new("--ignore-unmatch"),
                    OsStr::new("--"),
                    OsStr::from_bytes(&literal),
                ],
            )
            .await?;
        } else if file.status.starts_with('R') {
            trash_existing(root, &file.id).await?;
            let current_path = literal_path(&file.id)?;
            let previous = file.old_id.as_deref().ok_or(Error::Stale)?;
            let previous_path = literal_path(previous)?;
            run(
                root,
                &[
                    OsStr::new("rm"),
                    OsStr::new("--cached"),
                    OsStr::new("-f"),
                    OsStr::new("--ignore-unmatch"),
                    OsStr::new("--"),
                    OsStr::from_bytes(&current_path),
                ],
            )
            .await?;
            run(
                root,
                &[
                    OsStr::new("restore"),
                    OsStr::new("--source=HEAD"),
                    OsStr::new("--staged"),
                    OsStr::new("--worktree"),
                    OsStr::new("--"),
                    OsStr::from_bytes(&previous_path),
                ],
            )
            .await?;
        } else {
            let literal = literal_path(&file.id)?;
            run(
                root,
                &[
                    OsStr::new("restore"),
                    OsStr::new("--source=HEAD"),
                    OsStr::new("--staged"),
                    OsStr::new("--worktree"),
                    OsStr::new("--"),
                    OsStr::from_bytes(&literal),
                ],
            )
            .await?;
        }
        acted = true;
    }
    if !acted {
        return Err(Error::Stale);
    }
    snapshot(root).await
}

#[tauri::command]
pub(crate) async fn restore_git_files(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    file_ids: Vec<String>,
    all: bool,
    expected_revision: String,
) -> Result<Snapshot, Error> {
    restore_or_trash_at(
        &root(&threads, thread_id).await?,
        file_ids,
        all,
        expected_revision,
        true,
    )
    .await
}

#[tauri::command]
pub(crate) async fn trash_git_files(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    file_ids: Vec<String>,
    expected_revision: String,
) -> Result<Snapshot, Error> {
    restore_or_trash_at(
        &root(&threads, thread_id).await?,
        file_ids,
        false,
        expected_revision,
        false,
    )
    .await
}

async fn stash_at(
    root: &Path,
    expected_revision: String,
    pop: bool,
    expected_stash: Option<String>,
) -> Result<Snapshot, Error> {
    let _guard = mutation().lock().await;
    let current = snapshot(root).await?;
    if current.operation.is_some() || current.files.iter().any(|file| file.conflict) {
        return Err(Error::InProgress);
    }
    if current.revision != expected_revision || (pop && current.latest_stash != expected_stash) {
        return Err(Error::Stale);
    }
    if pop {
        if current.latest_stash.is_none() {
            return Err(Error::Stale);
        }
        run(root, &[OsStr::new("stash"), OsStr::new("pop")]).await?;
    } else {
        if current.files.is_empty() {
            return Err(Error::Stale);
        }
        run(
            root,
            &[
                OsStr::new("stash"),
                OsStr::new("push"),
                OsStr::new("--include-untracked"),
            ],
        )
        .await?;
    }
    snapshot(root).await
}

#[tauri::command]
pub(crate) async fn stash_git_all(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    expected_revision: String,
) -> Result<Snapshot, Error> {
    stash_at(
        &root(&threads, thread_id).await?,
        expected_revision,
        false,
        None,
    )
    .await
}

#[tauri::command]
pub(crate) async fn stash_git_pop(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    expected_revision: String,
    expected_stash: Option<String>,
) -> Result<Snapshot, Error> {
    stash_at(
        &root(&threads, thread_id).await?,
        expected_revision,
        true,
        expected_stash,
    )
    .await
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

    #[tokio::test]
    async fn side_statistics_follow_partial_staging_and_unusual_paths() {
        let dir = repo().await;
        let root = dir.path();
        let unusual = OsStr::from_bytes(b"odd\nname");
        std::fs::write(root.join(unusual), "first\n").unwrap();
        git(root, &["add", "-A"]).await;
        git(root, &["commit", "-qm", "feat: base"]).await;
        std::fs::write(root.join(unusual), "first\nsecond\n").unwrap();
        git(root, &["add", "-A"]).await;
        std::fs::write(root.join(unusual), "third\n").unwrap();
        let state = snapshot(root).await.unwrap();
        let file = &state.files[0];
        assert_eq!(file.staged_change.as_ref().unwrap().additions, Some(1));
        assert_eq!(file.unstaged_change.as_ref().unwrap().deletions, Some(2));
        assert_ne!(
            file.staged_change.as_ref().unwrap().revision,
            file.unstaged_change.as_ref().unwrap().revision
        );
        std::fs::write(root.join("binary"), b"a\0b").unwrap();
        let state = snapshot(root).await.unwrap();
        let binary = state
            .files
            .iter()
            .find(|file| file.path == "binary")
            .unwrap();
        assert_eq!(binary.unstaged_change.as_ref().unwrap().additions, None);
    }

    #[tokio::test]
    async fn restore_resets_both_sides_and_keeps_original_untracked_files() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("tracked"), "base\n").unwrap();
        git(root, &["add", "tracked"]).await;
        git(root, &["commit", "-qm", "feat: base"]).await;
        std::fs::write(root.join("tracked"), "staged\n").unwrap();
        git(root, &["add", "tracked"]).await;
        std::fs::write(root.join("tracked"), "unstaged\n").unwrap();
        std::fs::write(root.join("new"), "preserve\n").unwrap();
        let before = snapshot(root).await.unwrap();
        let after = restore_or_trash_at(root, vec![], true, before.revision, true)
            .await
            .unwrap();
        assert_eq!(std::fs::read(root.join("tracked")).unwrap(), b"base\n");
        assert_eq!(std::fs::read(root.join("new")).unwrap(), b"preserve\n");
        assert_eq!(after.files.len(), 1);
        assert_eq!(after.files[0].status, "??");
    }

    #[tokio::test]
    async fn stash_all_includes_untracked_and_pop_does_not_restore_index() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("tracked"), "base\n").unwrap();
        git(root, &["add", "tracked"]).await;
        git(root, &["commit", "-qm", "feat: base"]).await;
        std::fs::write(root.join("tracked"), "changed\n").unwrap();
        git(root, &["add", "tracked"]).await;
        std::fs::write(root.join("untracked"), "new\n").unwrap();
        let before = snapshot(root).await.unwrap();
        let saved = stash_at(root, before.revision, false, None).await.unwrap();
        assert!(saved.files.is_empty());
        assert!(saved.latest_stash.is_some());
        let restored = stash_at(root, saved.revision, true, saved.latest_stash.clone())
            .await
            .unwrap();
        assert!(restored.latest_stash.is_none());
        assert_eq!(std::fs::read(root.join("untracked")).unwrap(), b"new\n");
        assert!(restored
            .files
            .iter()
            .any(|file| file.path == "tracked" && file.unstaged && !file.staged));
    }

    #[tokio::test]
    async fn stale_confirmation_rejects_trash() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("tracked"), "base\n").unwrap();
        git(root, &["add", "tracked"]).await;
        git(root, &["commit", "-qm", "feat: base"]).await;
        std::fs::write(root.join("tracked"), "changed\n").unwrap();
        let before = snapshot(root).await.unwrap();
        std::fs::write(root.join("tracked"), "newer content\n").unwrap();
        assert!(matches!(
            restore_or_trash_at(
                root,
                vec![before.files[0].id.clone()],
                false,
                before.revision,
                false
            )
            .await,
            Err(Error::Stale)
        ));
    }

    #[tokio::test]
    async fn restore_handles_a_staged_rename_whose_new_file_is_already_missing() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("before"), "content\n").unwrap();
        git(root, &["add", "before"]).await;
        git(root, &["commit", "-qm", "feat: base"]).await;
        std::fs::rename(root.join("before"), root.join("after")).unwrap();
        git(root, &["add", "-A"]).await;
        std::fs::remove_file(root.join("after")).unwrap();
        let current = snapshot(root).await.unwrap();
        let after = restore_or_trash_at(root, vec![], true, current.revision, true)
            .await
            .unwrap();
        assert!(after.files.is_empty());
        assert_eq!(std::fs::read(root.join("before")).unwrap(), b"content\n");
    }

    #[tokio::test]
    async fn restore_on_unborn_branch_removes_a_missing_staged_addition() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("new"), "content\n").unwrap();
        git(root, &["add", "new"]).await;
        std::fs::remove_file(root.join("new")).unwrap();
        let current = snapshot(root).await.unwrap();
        assert!(current.head.is_none());
        let restored = restore_or_trash_at(root, vec![], true, current.revision, true)
            .await
            .unwrap();
        assert!(restored.files.is_empty());
    }

    #[tokio::test]
    async fn stash_pop_conflict_keeps_the_stash() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("file"), "base\n").unwrap();
        git(root, &["add", "file"]).await;
        git(root, &["commit", "-qm", "feat: base"]).await;
        std::fs::write(root.join("file"), "stashed\n").unwrap();
        let pending = snapshot(root).await.unwrap();
        let saved = stash_at(root, pending.revision, false, None).await.unwrap();
        std::fs::write(root.join("file"), "committed\n").unwrap();
        git(root, &["commit", "-qam", "feat: change"]).await;
        let current = snapshot(root).await.unwrap();
        assert!(
            stash_at(root, current.revision, true, saved.latest_stash.clone())
                .await
                .is_err()
        );
        let after = snapshot(root).await.unwrap();
        assert_eq!(after.latest_stash, saved.latest_stash);
    }

    #[tokio::test]
    #[ignore = "requires permission to use the system Trash on macOS"]
    async fn trash_tracked_file_preserves_index() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("tracked"), "base\n").unwrap();
        git(root, &["add", "tracked"]).await;
        git(root, &["commit", "-qm", "feat: base"]).await;
        std::fs::write(root.join("tracked"), "changed\n").unwrap();
        let current = snapshot(root).await.unwrap();
        let after = restore_or_trash_at(
            root,
            vec![current.files[0].id.clone()],
            false,
            current.revision,
            false,
        )
        .await
        .unwrap();
        assert!(!root.join("tracked").exists());
        assert_eq!(after.files[0].status, " D");
    }
}
