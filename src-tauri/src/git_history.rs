//! Read-only Git history. A cursor owns a backpressured Git walk, not a full log.
use crate::{git, thread::Threads};
use serde::Serialize;
use std::{
    collections::HashMap,
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::State;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdout},
    sync::Mutex as AsyncMutex,
};
use uuid::Uuid;

const PAGE_SIZE: usize = 200;
const MAX_PATCH_BYTES: usize = 2 * 1024 * 1024;
const COMMIT_FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ct%x00%s";

#[derive(Debug, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub(crate) enum HistoryError {
    #[error("The working folder is not a Git repository")]
    NotRepository,
    #[error("The thread or history cursor is unavailable; refresh to try again")]
    Unavailable,
    #[error("Invalid Git history request")]
    InvalidRequest,
    #[error("Git: {0}")]
    Git(String),
}
impl From<git::Error> for HistoryError {
    fn from(error: git::Error) -> Self {
        Self::Git(error.to_string())
    }
}
impl From<std::io::Error> for HistoryError {
    fn from(error: std::io::Error) -> Self {
        Self::Git(error.to_string())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reference {
    name: String,
    label: String,
    oid: String,
    kind: &'static str,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Repository {
    root: PathBuf,
    references: Vec<Reference>,
    head: Option<String>,
    shallow: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Commit {
    oid: String,
    parents: Vec<String>,
    author: String,
    timestamp: i64,
    subject: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryPage {
    commits: Vec<Commit>,
    cursor: Option<Uuid>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct History {
    repository: Repository,
    page: HistoryPage,
}

struct Walk {
    child: Child,
    output: BufReader<ChildStdout>,
    stderr: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
    pending: Option<Commit>,
    done: bool,
}
impl Drop for Walk {
    fn drop(&mut self) {
        self.stderr.abort();
    }
}
struct Entry {
    thread: Uuid,
    walk: Arc<AsyncMutex<Walk>>,
}
#[derive(Default)]
pub(crate) struct GitHistory {
    walks: Mutex<HashMap<Uuid, Entry>>,
}
impl GitHistory {
    pub(crate) fn forget(&self, thread: Uuid) {
        if let Ok(mut walks) = self.walks.lock() {
            walks.retain(|_, entry| entry.thread != thread);
        }
    }
    pub(crate) fn clear(&self) {
        if let Ok(mut walks) = self.walks.lock() {
            walks.clear();
        }
    }
    fn remove(&self, thread: Uuid, cursor: Uuid) -> Result<(), HistoryError> {
        let mut walks = self.walks.lock().map_err(|_| HistoryError::Unavailable)?;
        if walks
            .get(&cursor)
            .is_some_and(|entry| entry.thread == thread)
        {
            walks.remove(&cursor);
        }
        Ok(())
    }
}

fn folder(threads: &Threads, thread: Uuid) -> Result<PathBuf, HistoryError> {
    threads
        .get(thread)
        .map(|thread| thread.working_folder)
        .map_err(|_| HistoryError::Unavailable)
}
async fn run(root: &Path, args: &[&str]) -> Result<Vec<u8>, HistoryError> {
    Ok(git::run(root, &args.iter().map(OsStr::new).collect::<Vec<_>>()).await?)
}
fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
fn valid_oid(oid: &str) -> bool {
    matches!(oid.len(), 40 | 64) && oid.bytes().all(|c| c.is_ascii_hexdigit())
}

async fn repository_root(folder: &Path) -> Result<PathBuf, HistoryError> {
    match git::run(folder, &["rev-parse".as_ref(), "--show-toplevel".as_ref()]).await {
        Ok(bytes) => Ok(PathBuf::from(text(&bytes).trim_end_matches('\n'))),
        Err(git::Error::Failed { .. }) => Err(HistoryError::NotRepository),
        Err(error) => Err(error.into()),
    }
}
async fn repository(folder: &Path) -> Result<Repository, HistoryError> {
    let root = repository_root(folder).await?;
    let output = run(&root, &["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)%00%(symref)", "refs/heads", "refs/remotes", "refs/tags"]).await?;
    let mut references = Vec::new();
    for line in output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let fields: Vec<_> = line.split(|byte| *byte == 0).collect();
        if fields.len() != 6 || !fields[5].is_empty() {
            continue;
        }
        let name = text(fields[0]);
        let oid = if fields[3] == b"commit" {
            text(fields[1])
        } else if fields[4] == b"commit" {
            text(fields[2])
        } else if fields[3] == b"tag" {
            // Nested annotated tags are uncommon; resolve only those individually.
            match run(
                &root,
                &[
                    "rev-parse",
                    "--verify",
                    &format!("{}^{{commit}}", text(fields[1])),
                ],
            )
            .await
            {
                Ok(bytes) => text(&bytes).trim().to_owned(),
                Err(_) => continue,
            }
        } else {
            continue;
        };
        let (kind, label) = if let Some(label) = name.strip_prefix("refs/heads/") {
            ("local", label)
        } else if let Some(label) = name.strip_prefix("refs/remotes/") {
            ("remote", label)
        } else {
            ("tag", name.strip_prefix("refs/tags/").unwrap_or(&name))
        };
        references.push(Reference {
            label: label.to_owned(),
            name,
            oid,
            kind,
        });
    }
    let head = match run(&root, &["rev-parse", "--verify", "HEAD"]).await {
        Ok(bytes) => Some(text(&bytes).trim().to_owned()),
        Err(_) => None,
    };
    let shallow = run(&root, &["rev-parse", "--is-shallow-repository"]).await? == b"true\n";
    Ok(Repository {
        root,
        references,
        head,
        shallow,
    })
}

fn parse_commit(fields: &[Vec<u8>]) -> Result<Commit, HistoryError> {
    if fields.len() != 5 {
        return Err(HistoryError::Git("Invalid commit record".into()));
    }
    let oid = text(&fields[0]);
    if !valid_oid(&oid) {
        return Err(HistoryError::Git("Invalid commit object ID".into()));
    }
    Ok(Commit {
        oid,
        parents: text(&fields[1])
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        author: text(&fields[2]),
        timestamp: text(&fields[3])
            .parse()
            .map_err(|_| HistoryError::Git("Invalid commit timestamp".into()))?,
        subject: text(&fields[4]),
    })
}
impl Walk {
    async fn start(root: &Path, tips: &[String]) -> Result<Self, HistoryError> {
        let mut child = git::spawn(
            root,
            &[
                "log".as_ref(),
                "--stdin".as_ref(),
                "--topo-order".as_ref(),
                "--no-decorate".as_ref(),
                "--no-show-signature".as_ref(),
                "--no-notes".as_ref(),
                "--no-patch".as_ref(),
                "--encoding=UTF-8".as_ref(),
                "-z".as_ref(),
                COMMIT_FORMAT.as_ref(),
            ],
        )?;
        let output = BufReader::new(child.stdout.take().ok_or(HistoryError::Unavailable)?);
        let mut errors = child.stderr.take().ok_or(HistoryError::Unavailable)?;
        let stderr = tokio::spawn(async move {
            let mut bytes = Vec::new();
            errors.read_to_end(&mut bytes).await?;
            Ok(bytes)
        });
        let mut input = child.stdin.take().ok_or(HistoryError::Unavailable)?;
        input.write_all(tips.join("\n").as_bytes()).await?;
        input.write_all(b"\n").await?;
        drop(input);
        Ok(Self {
            child,
            output,
            stderr,
            pending: None,
            done: false,
        })
    }
    async fn next(&mut self) -> Result<Option<Commit>, HistoryError> {
        if self.done {
            return Ok(None);
        }
        let mut fields = Vec::with_capacity(5);
        for index in 0..5 {
            let mut field = Vec::new();
            let read = self.output.read_until(0, &mut field).await?;
            if read == 0 && index == 0 {
                self.done = true;
                let status = self.child.wait().await?;
                if !status.success() {
                    let errors = (&mut self.stderr)
                        .await
                        .map_err(|_| HistoryError::Unavailable)??;
                    return Err(HistoryError::Git(text(&errors)));
                }
                return Ok(None);
            }
            if field.pop() != Some(0) {
                return Err(HistoryError::Git("Incomplete commit record".into()));
            }
            fields.push(field);
        }
        parse_commit(&fields).map(Some)
    }
    async fn page(&mut self, cursor: Uuid) -> Result<HistoryPage, HistoryError> {
        let mut commits = Vec::with_capacity(PAGE_SIZE);
        if let Some(commit) = self.pending.take() {
            commits.push(commit);
        }
        while commits.len() < PAGE_SIZE {
            match self.next().await? {
                Some(commit) => commits.push(commit),
                None => break,
            }
        }
        self.pending = self.next().await?;
        Ok(HistoryPage {
            commits,
            cursor: self.pending.as_ref().map(|_| cursor),
        })
    }
}

#[tauri::command]
pub(crate) async fn open_git_history(
    threads: State<'_, Threads>,
    history: State<'_, GitHistory>,
    thread_id: Uuid,
    reference: Option<String>,
) -> Result<History, HistoryError> {
    let repository = repository(&folder(&threads, thread_id)?).await?;
    let mut tips = if let Some(name) = reference {
        vec![repository
            .references
            .iter()
            .find(|reference| reference.name == name)
            .ok_or(HistoryError::InvalidRequest)?
            .oid
            .clone()]
    } else {
        repository
            .references
            .iter()
            .map(|reference| reference.oid.clone())
            .chain(repository.head.iter().cloned())
            .collect::<Vec<_>>()
    };
    tips.sort();
    tips.dedup();
    if tips.is_empty() {
        return Ok(History {
            repository,
            page: HistoryPage {
                commits: Vec::new(),
                cursor: None,
            },
        });
    }
    let cursor = Uuid::new_v4();
    let mut walk = Walk::start(&repository.root, &tips).await?;
    let page = walk.page(cursor).await?;
    if page.cursor.is_some() {
        history
            .walks
            .lock()
            .map_err(|_| HistoryError::Unavailable)?
            .insert(
                cursor,
                Entry {
                    thread: thread_id,
                    walk: Arc::new(AsyncMutex::new(walk)),
                },
            );
    }
    Ok(History { repository, page })
}
#[tauri::command]
pub(crate) async fn read_git_history_page(
    threads: State<'_, Threads>,
    history: State<'_, GitHistory>,
    thread_id: Uuid,
    cursor: Uuid,
) -> Result<HistoryPage, HistoryError> {
    folder(&threads, thread_id)?;
    let walk = history
        .walks
        .lock()
        .map_err(|_| HistoryError::Unavailable)?
        .get(&cursor)
        .filter(|entry| entry.thread == thread_id)
        .map(|entry| Arc::clone(&entry.walk))
        .ok_or(HistoryError::Unavailable)?;
    let page = walk.lock().await.page(cursor).await;
    if !matches!(&page, Ok(page) if page.cursor.is_some()) {
        history.remove(thread_id, cursor)?;
    }
    page
}
#[tauri::command]
pub(crate) fn close_git_history(
    history: State<'_, GitHistory>,
    thread_id: Uuid,
    cursor: Uuid,
) -> Result<(), HistoryError> {
    history.remove(thread_id, cursor)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangedFile {
    additions: Option<u64>,
    deletions: Option<u64>,
    path: String,
    old_path: Option<String>,
    change: String,
    old_mode: String,
    new_mode: String,
    old_oid: String,
    new_oid: String,
    #[serde(skip)]
    paths: Vec<Vec<u8>>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitDetails {
    commit: Commit,
    body: String,
    base: Option<String>,
    boundary: bool,
    files: Vec<ChangedFile>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "patch", rename_all = "camelCase")]
pub(crate) enum FilePatch {
    Text(String),
    Binary,
    TooLarge,
    Unsupported,
    Submodule,
}

fn parse_files(bytes: &[u8]) -> Result<Vec<ChangedFile>, HistoryError> {
    let mut fields = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut files = Vec::new();
    while let Some(header) = fields.next() {
        let header = text(header);
        let parts: Vec<_> = header.trim_start_matches(':').split_whitespace().collect();
        if parts.len() != 5 {
            return Err(HistoryError::Git("Invalid changed file record".into()));
        }
        let first = fields.next().ok_or(HistoryError::Unavailable)?.to_vec();
        let renamed = parts[4].starts_with(['R', 'C']);
        let second = if renamed {
            Some(fields.next().ok_or(HistoryError::Unavailable)?.to_vec())
        } else {
            None
        };
        let path = text(second.as_deref().unwrap_or(&first));
        let old_path = second.as_ref().map(|_| text(&first));
        let mut paths = vec![first];
        if let Some(second) = second {
            paths.push(second);
        }
        files.push(ChangedFile {
            additions: None,
            deletions: None,
            path,
            old_path,
            change: parts[4].to_owned(),
            old_mode: parts[0].into(),
            new_mode: parts[1].into(),
            old_oid: parts[2].into(),
            new_oid: parts[3].into(),
            paths,
        });
    }
    Ok(files)
}

fn apply_numstat(files: &mut [ChangedFile], bytes: &[u8]) -> Result<(), HistoryError> {
    let invalid = || HistoryError::Git("Invalid file line statistics".into());
    let mut fields = bytes.split(|byte| *byte == 0);
    let mut stats = HashMap::new();
    while let Some(record) = fields.next() {
        if record.is_empty() && fields.clone().next().is_none() {
            break;
        }
        let mut columns = record.splitn(3, |byte| *byte == b'\t');
        let added = columns.next().ok_or_else(invalid)?;
        let deleted = columns.next().ok_or_else(invalid)?;
        let path = columns.next().ok_or_else(invalid)?;
        let counts = if added == b"-" && deleted == b"-" {
            (None, None)
        } else {
            let count = |value: &[u8]| {
                std::str::from_utf8(value)
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .ok_or_else(invalid)
            };
            (Some(count(added)?), Some(count(deleted)?))
        };
        // With -z a rename has an empty path followed by two raw paths.
        let paths = if path.is_empty() {
            vec![
                fields.next().ok_or_else(invalid)?.to_vec(),
                fields.next().ok_or_else(invalid)?.to_vec(),
            ]
        } else {
            vec![path.to_vec()]
        };
        if stats.insert(paths, counts).is_some() {
            return Err(invalid());
        }
    }
    for file in files {
        let (additions, deletions) = stats.remove(&file.paths).ok_or_else(invalid)?;
        file.additions = additions;
        file.deletions = deletions;
    }
    if !stats.is_empty() {
        return Err(invalid());
    }
    Ok(())
}

async fn details_with_stats(root: &Path, oid: &str) -> Result<CommitDetails, HistoryError> {
    let mut details = details(root, oid).await?;
    if details.files.is_empty() {
        return Ok(details);
    }
    let mut args = vec![
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--numstat",
        "-r",
        "-z",
        "-M",
        "--no-ext-diff",
        "--no-textconv",
    ];
    if let Some(base) = details.base.as_deref() {
        args.push(base);
    }
    args.extend([oid, "--"]);
    apply_numstat(&mut details.files, &run(root, &args).await?)?;
    Ok(details)
}
async fn details(root: &Path, oid: &str) -> Result<CommitDetails, HistoryError> {
    if !valid_oid(oid) {
        return Err(HistoryError::InvalidRequest);
    }
    let output = run(
        root,
        &[
            "show",
            "--no-patch",
            "--no-show-signature",
            "--no-notes",
            "--encoding=UTF-8",
            "--format=%H%x00%P%x00%an%x00%ct%x00%s%x00%b",
            oid,
            "--",
        ],
    )
    .await?;
    let fields: Vec<_> = output
        .splitn(6, |byte| *byte == 0)
        .map(<[u8]>::to_vec)
        .collect();
    if fields.len() != 6 {
        return Err(HistoryError::Unavailable);
    }
    let mut commit = parse_commit(&fields[..5])?;
    let mut boundary = false;
    if commit.parents.is_empty() {
        // Pretty formats hide parents at shallow boundaries; these are not roots.
        let raw = run(root, &["cat-file", "-p", oid]).await?;
        commit.parents = text(&raw)
            .lines()
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.strip_prefix("parent ").map(str::to_owned))
            .collect();
        if let Some(parent) = commit.parents.first() {
            boundary = run(root, &["cat-file", "-e", &format!("{parent}^{{tree}}")])
                .await
                .is_err();
        }
    }
    let base = commit.parents.first().cloned();
    let mut args = vec![
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--raw",
        "-r",
        "-z",
        "--no-abbrev",
        "-M",
    ];
    if let Some(base) = base.as_deref() {
        args.push(base);
    }
    args.extend([oid, "--"]);
    let files = if boundary {
        Vec::new()
    } else {
        parse_files(&run(root, &args).await?)?
    };
    Ok(CommitDetails {
        commit,
        body: text(&fields[5]).trim_end().to_owned(),
        base,
        boundary,
        files,
    })
}
#[tauri::command]
pub(crate) async fn read_git_commit(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    oid: String,
) -> Result<CommitDetails, HistoryError> {
    let root = repository_root(&folder(&threads, thread_id)?).await?;
    details_with_stats(&root, &oid).await
}
#[tauri::command]
pub(crate) async fn read_git_commit_file(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    oid: String,
    index: usize,
) -> Result<FilePatch, HistoryError> {
    let root = repository_root(&folder(&threads, thread_id)?).await?;
    patch(&root, &oid, index).await
}
async fn patch(root: &Path, oid: &str, index: usize) -> Result<FilePatch, HistoryError> {
    use std::os::unix::ffi::OsStrExt;
    let details = details(root, oid).await?;
    let file = details
        .files
        .get(index)
        .ok_or(HistoryError::InvalidRequest)?;
    if file.old_mode == "160000" || file.new_mode == "160000" {
        return Ok(FilePatch::Submodule);
    }
    for blob in [&file.old_oid, &file.new_oid]
        .into_iter()
        .filter(|oid| !oid.bytes().all(|byte| byte == b'0'))
    {
        let size = run(root, &["cat-file", "-s", blob]).await?;
        if text(&size)
            .trim()
            .parse::<usize>()
            .map_err(|_| HistoryError::Unavailable)?
            > MAX_PATCH_BYTES
        {
            return Ok(FilePatch::TooLarge);
        }
    }
    let mut args = vec![
        "diff-tree".as_ref(),
        "--root".as_ref(),
        "--no-commit-id".as_ref(),
        "-r".as_ref(),
        "-M".as_ref(),
        "--no-ext-diff".as_ref(),
        "--no-textconv".as_ref(),
        "--no-color".as_ref(),
        "--src-prefix=a/".as_ref(),
        "--dst-prefix=b/".as_ref(),
    ];
    if let Some(base) = details.base.as_deref() {
        args.push(base.as_ref());
    }
    args.extend([
        OsStr::new(oid),
        OsStr::new("--numstat"),
        OsStr::new("-p"),
        OsStr::new("--"),
    ]);
    // Literal pathspecs preserve unusual names and cannot expand to other files.
    let paths: Vec<_> = file
        .paths
        .iter()
        .map(|path| {
            let mut literal = b":(literal)".to_vec();
            literal.extend(path);
            literal
        })
        .collect();
    args.extend(paths.iter().map(|path| OsStr::from_bytes(path)));
    let mut child = git::spawn(root, &args)?;
    drop(child.stdin.take());
    let mut output = child.stdout.take().ok_or(HistoryError::Unavailable)?;
    let mut stderr = child.stderr.take().ok_or(HistoryError::Unavailable)?;
    let errors = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    });
    let mut bytes = Vec::new();
    (&mut output)
        .take((MAX_PATCH_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > MAX_PATCH_BYTES {
        child.kill().await?;
        errors.abort();
        return Ok(FilePatch::TooLarge);
    }
    let status = child.wait().await?;
    let stderr = errors.await.map_err(|_| HistoryError::Unavailable)??;
    if !status.success() {
        return Err(HistoryError::Git(text(&stderr)));
    }
    // Numstat's binary marker is machine-readable regardless of Git's locale.
    if bytes.starts_with(b"-\t-\t") {
        return Ok(FilePatch::Binary);
    }
    let Ok(patch) = String::from_utf8(bytes) else {
        return Ok(FilePatch::Unsupported);
    };
    Ok(FilePatch::Text(patch))
}

#[cfg(test)]
mod tests;
