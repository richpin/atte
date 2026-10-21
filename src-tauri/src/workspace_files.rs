//! Thread-scoped workspace browsing and optimistic, explicit file writes.
use crate::thread::Threads;
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, State};
use uuid::Uuid;

const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FileError {
    #[error("The thread or working folder is unavailable")]
    Unavailable,
    #[error("The path is outside the working folder or protected")]
    InvalidPath,
    #[error("The file no longer exists")]
    Missing,
    #[error("An item with that name already exists")]
    Exists,
    #[error("The file changed on disk; reload before saving")]
    Conflict,
    #[error("You do not have permission to access this item")]
    AccessDenied,
    #[error("This file is read-only")]
    ReadOnly,
    #[error("Only UTF-8 text files up to 2 MiB can be opened")]
    Unsupported,
    #[error("Only PNG, JPEG, GIF, WebP, BMP and ICO images can be previewed")]
    UnsupportedImage,
    #[error("Images larger than 20 MiB cannot be previewed")]
    ImageTooLarge,
    #[error("Filesystem operation failed: {0}")]
    Io(String),
}
impl From<String> for FileError {
    fn from(message: String) -> Self {
        Self::Io(message)
    }
}
impl From<std::io::Error> for FileError {
    fn from(error: std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::Missing,
            std::io::ErrorKind::AlreadyExists => Self::Exists,
            std::io::ErrorKind::PermissionDenied => Self::AccessDenied,
            _ => Self::Io(error.to_string()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    path: String,
    directory: bool,
    symlink: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextFile {
    text: String,
    version: String,
    read_only: bool,
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum FileUpdate {
    Snapshot {
        entries: Vec<Entry>,
        warnings: Vec<String>,
    },
    Changed {
        entries: Vec<Entry>,
        removed: Vec<String>,
        changed: Vec<String>,
        warnings: Vec<String>,
    },
    Error {
        message: String,
    },
}
struct Subscription {
    thread: Uuid,
    stop: Arc<AtomicBool>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
#[derive(Default)]
pub(crate) struct WorkspaceFiles {
    subscriptions: Mutex<HashMap<Uuid, Subscription>>,
    writes: Mutex<()>,
}
impl WorkspaceFiles {
    pub(crate) fn forget(&self, thread: Uuid) {
        if let Ok(mut subscriptions) = self.subscriptions.lock() {
            subscriptions.retain(|_, subscription| subscription.thread != thread);
        }
    }
    pub(crate) fn clear(&self) {
        if let Ok(mut subscriptions) = self.subscriptions.lock() {
            subscriptions.clear();
        }
    }
}
fn root(threads: &Threads, thread: Uuid) -> Result<PathBuf, FileError> {
    let folder = threads
        .get(thread)
        .map_err(|_| FileError::Unavailable)?
        .working_folder;
    if !folder.is_dir() {
        return Err(FileError::Unavailable);
    }
    folder.canonicalize().map_err(|_| FileError::Unavailable)
}
// Resolve only the parent: rename/trash operate on the link itself, not its target.
fn resolve(root: &Path, relative: &str) -> Result<PathBuf, FileError> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || path.components().any(|part| part.as_os_str() == ".git")
    {
        return Err(FileError::InvalidPath);
    }
    let parent = root
        .join(path.parent().ok_or(FileError::InvalidPath)?)
        .canonicalize()?;
    if !parent.starts_with(root)
        || parent
            .strip_prefix(root)
            .is_ok_and(|relative| relative.components().any(|part| part.as_os_str() == ".git"))
    {
        return Err(FileError::InvalidPath);
    }
    Ok(parent.join(path.file_name().ok_or(FileError::InvalidPath)?))
}
fn regular_bytes(path: &Path, limit: u64) -> Result<(Vec<u8>, fs::Metadata), FileError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(FileError::Unsupported);
    }
    let too_large = || {
        if limit == MAX_IMAGE_BYTES {
            FileError::ImageTooLarge
        } else {
            FileError::Unsupported
        }
    };
    if metadata.len() > limit {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(too_large());
    }
    Ok((bytes, metadata))
}
fn version(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read_target(root: &Path, relative: &str) -> Result<(PathBuf, bool), FileError> {
    let path = resolve(root, relative)?;
    let link = fs::symlink_metadata(&path)?.is_symlink();
    let target = path.canonicalize()?;
    if !target.starts_with(root)
        || target
            .strip_prefix(root)
            .is_ok_and(|relative| relative.components().any(|part| part.as_os_str() == ".git"))
    {
        return Err(FileError::InvalidPath);
    }
    Ok((target, link))
}
fn image_extension(relative: &str) -> Option<String> {
    let extension = Path::new(relative)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => Some("jpg".into()),
        "png" | "gif" | "webp" | "bmp" | "ico" => Some(extension),
        _ => None,
    }
}

pub(crate) fn supports_preview(root: &Path, relative: &str) -> Result<bool, FileError> {
    let result = if image_extension(relative).is_some() {
        image_file(root, relative).map(|_| true)
    } else {
        text_file(root, relative).map(|file| {
            infer::get(file.text.as_bytes()).is_none_or(|kind| {
                kind.mime_type().starts_with("text/") || kind.mime_type() == "image/svg+xml"
            })
        })
    };
    match result {
        Ok(supported) => Ok(supported),
        Err(FileError::Unsupported | FileError::UnsupportedImage | FileError::ImageTooLarge) => {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

fn image_file(root: &Path, relative: &str) -> Result<Vec<u8>, FileError> {
    let (target, _) = read_target(root, relative)?;
    let expected = image_extension(relative).ok_or(FileError::UnsupportedImage)?;
    let (bytes, _) = regular_bytes(&target, MAX_IMAGE_BYTES)?;
    if !infer::get(&bytes).is_some_and(|kind| kind.extension() == expected) {
        return Err(FileError::UnsupportedImage);
    }
    Ok(bytes)
}
fn text_file(root: &Path, relative: &str) -> Result<TextFile, FileError> {
    let (target, link) = read_target(root, relative)?;
    let (bytes, metadata) = regular_bytes(&target, MAX_BYTES)?;
    let content = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    if content.contains(&0) {
        return Err(FileError::Unsupported);
    }
    let text = std::str::from_utf8(content)
        .map_err(|_| FileError::Unsupported)?
        .to_owned();
    Ok(TextFile {
        text,
        version: version(&bytes),
        read_only: link || metadata.permissions().readonly(),
    })
}
fn save_text(
    root: &Path,
    relative: &str,
    expected: &str,
    text: &str,
) -> Result<TextFile, FileError> {
    let path = resolve(root, relative)?;
    if fs::symlink_metadata(&path)?.is_symlink() {
        return Err(FileError::ReadOnly);
    }
    let (old, metadata) = regular_bytes(&path, MAX_BYTES)?;
    if metadata.permissions().readonly() {
        return Err(FileError::ReadOnly);
    }
    if version(&old) != expected {
        return Err(FileError::Conflict);
    }
    let old_text = old.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&old);
    let old_text = std::str::from_utf8(old_text).map_err(|_| FileError::Unsupported)?;
    let normalized = text.replace("\r\n", "\n");
    let text = if old_text.contains("\r\n") {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    };
    let mut bytes = Vec::new();
    if old.starts_with(&[0xef, 0xbb, 0xbf]) {
        bytes.extend([0xef, 0xbb, 0xbf]);
    }
    bytes.extend(text.as_bytes());
    if bytes.len() as u64 > MAX_BYTES || text.contains('\0') {
        return Err(FileError::Unsupported);
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().ok_or(FileError::InvalidPath)?)?;
    temporary.write_all(&bytes)?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())?;
    temporary.as_file().sync_all()?;
    // Recheck immediately before replacement, including saves while typing.
    if version(&regular_bytes(&path, MAX_BYTES)?.0) != expected {
        return Err(FileError::Conflict);
    }
    temporary
        .persist(&path)
        .map_err(|error| FileError::from(error.error))?;
    Ok(TextFile {
        text,
        version: version(&bytes),
        read_only: false,
    })
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum FileOperation {
    Create { path: String, directory: bool },
    Move { from: String, to: String },
    Trash { path: String },
}
fn operate(root: &Path, operation: FileOperation) -> Result<(), FileError> {
    match operation {
        FileOperation::Create { path, directory } => {
            let path = resolve(root, &path)?;
            if directory {
                fs::create_dir(path)?;
            } else {
                OpenOptions::new().write(true).create_new(true).open(path)?;
            }
        }
        FileOperation::Move { from, to } => {
            let from = resolve(root, &from)?;
            let to = resolve(root, &to)?;
            if to.starts_with(&from) {
                return Err(FileError::InvalidPath);
            }
            rustix::fs::renameat_with(
                rustix::fs::CWD,
                &from,
                rustix::fs::CWD,
                &to,
                rustix::fs::RenameFlags::NOREPLACE,
            )
            .map_err(|error| FileError::from(std::io::Error::from(error)))?;
        }
        FileOperation::Trash { path } => {
            trash_item(&resolve(root, &path)?).map_err(|error| FileError::Io(error.to_string()))?;
        }
    }
    Ok(())
}

fn trash_item(path: &Path) -> Result<(), trash::Error> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut context = trash::TrashContext::new();
        // Native file management needs no Finder Automation permission.
        context.set_delete_method(DeleteMethod::NsFileManager);
        context.delete(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(path)
    }
}

fn scan(
    root: &Path,
    directory: &Path,
    entries: &mut BTreeMap<String, Entry>,
    warnings: &mut Vec<String>,
    stop: &AtomicBool,
) {
    if stop.load(Ordering::Acquire) {
        return;
    }
    let children = match fs::read_dir(directory) {
        Ok(children) => children,
        Err(error) => {
            warnings.push(format!("{}: {error}", directory.display()));
            return;
        }
    };
    for child in children {
        if stop.load(Ordering::Acquire) {
            return;
        }
        let child = match child {
            Ok(child) => child,
            Err(error) => {
                warnings.push(error.to_string());
                continue;
            }
        };
        if child.file_name() == ".git" {
            continue;
        }
        let path = child.path();
        let Some(relative) = path.strip_prefix(root).ok().and_then(Path::to_str) else {
            warnings.push(path.display().to_string());
            continue;
        };
        match child.file_type() {
            Ok(kind) => {
                entries.insert(
                    relative.to_owned(),
                    Entry {
                        path: relative.to_owned(),
                        directory: kind.is_dir(),
                        symlink: kind.is_symlink(),
                    },
                );
                if kind.is_dir() {
                    scan(root, &path, entries, warnings, stop);
                }
            }
            Err(error) => warnings.push(format!("{}: {error}", path.display())),
        }
    }
}
fn watch(root: PathBuf, channel: Channel<FileUpdate>, stop: Arc<AtomicBool>) {
    let (send, receive) = std::sync::mpsc::channel();
    let watcher = notify::RecommendedWatcher::new(
        move |event| {
            let _ = send.send(event);
        },
        notify::Config::default().with_follow_symlinks(false),
    );
    let mut watcher = match watcher {
        Ok(watcher) => watcher,
        Err(error) => {
            let _ = channel.send(FileUpdate::Error {
                message: error.to_string(),
            });
            return;
        }
    };
    // Watch before scanning so changes during the initial snapshot are reconciled.
    if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
        let _ = channel.send(FileUpdate::Error {
            message: error.to_string(),
        });
    }
    let mut entries = BTreeMap::new();
    let mut warnings = Vec::new();
    scan(&root, &root, &mut entries, &mut warnings, &stop);
    if stop.load(Ordering::Acquire)
        || channel
            .send(FileUpdate::Snapshot {
                entries: entries.values().cloned().collect(),
                warnings,
            })
            .is_err()
    {
        return;
    }
    while !stop.load(Ordering::Acquire) {
        let event = match receive.recv_timeout(Duration::from_millis(250)) {
            Ok(event) => event,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        };
        let mut events = vec![event];
        // One short batching window; sustained writes must not starve delivery.
        std::thread::sleep(Duration::from_millis(100));
        events.extend(receive.try_iter().take(4096));
        let mut directories = BTreeSet::new();
        let mut full_rescan = false;
        let mut changed = BTreeSet::new();
        let mut warnings = Vec::new();
        for event in events {
            match event {
                Ok(event) => {
                    if matches!(event.kind, notify::EventKind::Access(_)) {
                        continue;
                    }
                    if event.need_rescan() {
                        full_rescan = true;
                        directories.insert(root.clone());
                    }
                    for path in event.paths {
                        if !path.starts_with(&root)
                            || path.components().any(|part| part.as_os_str() == ".git")
                        {
                            continue;
                        }
                        if let Ok(relative) = path.strip_prefix(&root) {
                            changed.insert(relative.to_string_lossy().into_owned());
                        }
                        directories.insert(
                            path.parent()
                                .filter(|parent| parent.starts_with(&root))
                                .unwrap_or(&root)
                                .to_owned(),
                        );
                    }
                }
                Err(error) => {
                    warnings.push(error.to_string());
                    full_rescan = true;
                    directories.insert(root.clone());
                }
            }
        }
        let mut replacements = BTreeMap::new();
        let mut removed = Vec::new();
        for directory in directories {
            if full_rescan && directory != root {
                continue;
            }
            let prefix = directory.strip_prefix(&root).unwrap_or(Path::new(""));
            let previous: Vec<String> = entries
                .keys()
                .filter(|path| {
                    if full_rescan {
                        Path::new(path).starts_with(prefix)
                    } else {
                        Path::new(path).parent() == Some(prefix)
                    }
                })
                .cloned()
                .collect();
            let mut current = BTreeMap::new();
            if full_rescan {
                scan(&root, &directory, &mut current, &mut warnings, &stop);
            } else if let Ok(children) = fs::read_dir(&directory) {
                for child in children {
                    let child = match child {
                        Ok(child) => child,
                        Err(error) => {
                            warnings.push(error.to_string());
                            continue;
                        }
                    };
                    if child.file_name() == ".git" {
                        continue;
                    }
                    let path = child.path();
                    let Some(relative) = path.strip_prefix(&root).ok().and_then(Path::to_str)
                    else {
                        continue;
                    };
                    let kind = match child.file_type() {
                        Ok(kind) => kind,
                        Err(error) => {
                            warnings.push(error.to_string());
                            continue;
                        }
                    };
                    let entry = Entry {
                        path: relative.to_owned(),
                        directory: kind.is_dir(),
                        symlink: kind.is_symlink(),
                    };
                    if kind.is_dir() && entries.get(relative) != Some(&entry) {
                        scan(&root, &path, &mut current, &mut warnings, &stop);
                    }
                    current.insert(relative.to_owned(), entry);
                }
            } else if directory.exists() {
                warnings.push(format!("{}: cannot read directory", directory.display()));
                continue;
            }
            for path in previous {
                if !current.contains_key(&path) {
                    let descendants: Vec<String> = entries
                        .keys()
                        .filter(|candidate| Path::new(candidate).starts_with(&path))
                        .cloned()
                        .collect();
                    for removed_path in descendants {
                        entries.remove(&removed_path);
                        removed.push(removed_path);
                    }
                }
            }
            for (path, entry) in current {
                if entries.get(&path) != Some(&entry) {
                    replacements.insert(path.clone(), entry.clone());
                }
                entries.insert(path, entry);
            }
        }
        if stop.load(Ordering::Acquire) {
            return;
        }
        if (!changed.is_empty()
            || !removed.is_empty()
            || !replacements.is_empty()
            || !warnings.is_empty())
            && channel
                .send(FileUpdate::Changed {
                    entries: replacements.into_values().collect(),
                    removed,
                    changed: changed.into_iter().collect(),
                    warnings,
                })
                .is_err()
        {
            return;
        }
    }
}

#[tauri::command]
pub(crate) async fn subscribe_workspace_files(
    threads: State<'_, Threads>,
    files: State<'_, WorkspaceFiles>,
    thread_id: Uuid,
    subscription_id: Uuid,
    channel: Channel<FileUpdate>,
) -> Result<(), FileError> {
    let root = root(&threads, thread_id)?;
    let stop = Arc::new(AtomicBool::new(false));
    files
        .subscriptions
        .lock()
        .map_err(|_| FileError::Unavailable)?
        .insert(
            subscription_id,
            Subscription {
                thread: thread_id,
                stop: stop.clone(),
            },
        );
    tauri::async_runtime::spawn_blocking(move || watch(root, channel, stop));
    Ok(())
}
#[tauri::command]
pub(crate) fn unsubscribe_workspace_files(
    files: State<'_, WorkspaceFiles>,
    subscription_id: Uuid,
) -> Result<(), FileError> {
    files
        .subscriptions
        .lock()
        .map_err(|_| FileError::Unavailable)?
        .remove(&subscription_id);
    Ok(())
}
#[tauri::command]
pub(crate) async fn read_workspace_file(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    path: String,
) -> Result<TextFile, FileError> {
    let root = root(&threads, thread_id)?;
    tauri::async_runtime::spawn_blocking(move || text_file(&root, &path))
        .await
        .map_err(|_| FileError::Unavailable)?
}
#[tauri::command]
pub(crate) async fn read_workspace_image(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    path: String,
) -> Result<tauri::ipc::Response, FileError> {
    let root = root(&threads, thread_id)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || image_file(&root, &path))
        .await
        .map_err(|_| FileError::Unavailable)??;
    Ok(tauri::ipc::Response::new(bytes))
}
#[tauri::command]
pub(crate) async fn save_workspace_file(
    app: tauri::AppHandle,
    lifecycle: State<'_, crate::lifecycle::Lifecycle>,
    threads: State<'_, Threads>,
    thread_id: Uuid,
    path: String,
    version: String,
    text: String,
) -> Result<TextFile, FileError> {
    use tauri::Manager;
    let root = root(&threads, thread_id)?;
    lifecycle
        .finish_before_exit(async move {
            tauri::async_runtime::spawn_blocking(move || {
                let files = app.state::<WorkspaceFiles>();
                let _lock = files.writes.lock().map_err(|_| FileError::Unavailable)?;
                save_text(&root, &path, &version, &text)
            })
            .await
            .map_err(|_| FileError::Unavailable)?
        })
        .await
}
#[tauri::command]
pub(crate) async fn operate_workspace_file(
    app: tauri::AppHandle,
    lifecycle: State<'_, crate::lifecycle::Lifecycle>,
    threads: State<'_, Threads>,
    thread_id: Uuid,
    operation: FileOperation,
) -> Result<(), FileError> {
    use tauri::Manager;
    let root = root(&threads, thread_id)?;
    lifecycle
        .finish_before_exit(async move {
            tauri::async_runtime::spawn_blocking(move || {
                let files = app.state::<WorkspaceFiles>();
                let _lock = files.writes.lock().map_err(|_| FileError::Unavailable)?;
                operate(&root, operation)
            })
            .await
            .map_err(|_| FileError::Unavailable)?
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> tempfile::TempDir {
        tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
    }
    #[test]
    fn includes_hidden_ignored_files_and_empty_folders_without_following_links() {
        let folder = fixture();
        let root = folder.path();
        fs::create_dir(root.join("empty")).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "secret").unwrap();
        fs::write(root.join(".env"), "value").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/file"), "value").unwrap();
        std::os::unix::fs::symlink(root, root.join("loop")).unwrap();
        let mut entries = BTreeMap::new();
        let mut warnings = Vec::new();
        scan(
            root,
            root,
            &mut entries,
            &mut warnings,
            &AtomicBool::new(false),
        );
        assert_eq!(
            entries.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![".env", "empty", "loop", "node_modules", "node_modules/file"]
        );
    }
    #[test]
    fn rejects_escape_and_protected_paths() {
        let folder = fixture();
        for path in [
            "",
            "..",
            "../outside",
            "/etc/passwd",
            ".git/config",
            "a/../b",
        ] {
            assert!(resolve(folder.path(), path).is_err(), "{path}");
        }
    }
    #[test]
    fn rejects_parent_links_outside_root_and_reads_internal_file_links_only() {
        let folder = fixture();
        let outside = fixture();
        fs::write(outside.path().join("file"), "outside").unwrap();
        std::os::unix::fs::symlink(outside.path(), folder.path().join("escape")).unwrap();
        assert!(resolve(folder.path(), "escape/file").is_err());
        fs::write(folder.path().join("file"), "inside").unwrap();
        std::os::unix::fs::symlink(folder.path().join("file"), folder.path().join("link")).unwrap();
        assert!(text_file(folder.path(), "link").unwrap().read_only);
    }
    #[test]
    fn saves_preserve_bom_crlf_permissions_and_reject_stale_versions() {
        use std::os::unix::fs::PermissionsExt;
        let folder = fixture();
        let root = folder.path();
        fs::write(root.join("file"), b"\xef\xbb\xbffirst\r\n").unwrap();
        fs::set_permissions(root.join("file"), fs::Permissions::from_mode(0o640)).unwrap();
        let initial = text_file(root, "file").unwrap();
        save_text(root, "file", &initial.version, "second\n").unwrap();
        assert_eq!(
            fs::read(root.join("file")).unwrap(),
            b"\xef\xbb\xbfsecond\r\n"
        );
        assert_eq!(
            fs::metadata(root.join("file"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
        assert!(matches!(
            save_text(root, "file", &initial.version, "overwrite"),
            Err(FileError::Conflict)
        ));
    }
    #[test]
    fn reads_supported_image_signatures_with_matching_case_insensitive_extensions() {
        let folder = fixture();
        for (name, bytes) in [
            ("image.PNG", b"\x89PNG\r\n\x1a\n".as_slice()),
            ("image.jpg", b"\xff\xd8\xff\xe0".as_slice()),
            ("image.JPEG", b"\xff\xd8\xff\xe1".as_slice()),
            ("image.gif", b"GIF89a".as_slice()),
            ("image.webp", b"RIFF\x00\x00\x00\x00WEBP".as_slice()),
            ("image.bmp", b"BM\x00\x00".as_slice()),
            ("image.ico", b"\x00\x00\x01\x00".as_slice()),
        ] {
            fs::write(folder.path().join(name), bytes).unwrap();
            assert_eq!(image_file(folder.path(), name).unwrap(), bytes, "{name}");
        }
    }
    #[test]
    fn rejects_disguised_and_unsupported_images() {
        let folder = fixture();
        for (name, bytes) in [
            ("text.png", b"not an image".as_slice()),
            (
                "svg.png",
                b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".as_slice(),
            ),
            ("png.jpg", b"\x89PNG\r\n\x1a\n".as_slice()),
            ("image.svg", b"<svg/>".as_slice()),
            ("image.txt", b"\x89PNG\r\n\x1a\n".as_slice()),
        ] {
            fs::write(folder.path().join(name), bytes).unwrap();
            assert!(
                matches!(
                    image_file(folder.path(), name),
                    Err(FileError::UnsupportedImage)
                ),
                "{name}"
            );
        }
    }
    #[test]
    fn limits_image_bytes_independently_from_text_bytes() {
        let folder = fixture();
        let path = folder.path().join("large.png");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(b"\x89PNG\r\n\x1a\n").unwrap();
        file.set_len(MAX_IMAGE_BYTES).unwrap();
        assert_eq!(
            image_file(folder.path(), "large.png").unwrap().len() as u64,
            MAX_IMAGE_BYTES
        );
        assert!(matches!(
            text_file(folder.path(), "large.png"),
            Err(FileError::Unsupported)
        ));
        file.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(matches!(
            image_file(folder.path(), "large.png"),
            Err(FileError::ImageTooLarge)
        ));
    }
    #[test]
    fn image_reads_reject_escapes_protected_paths_and_non_regular_files() {
        use std::os::unix::fs::symlink;
        let folder = fixture();
        let outside = fixture();
        let root = folder.path();
        let png = b"\x89PNG\r\n\x1a\n";
        fs::write(root.join("inside.png"), png).unwrap();
        fs::write(outside.path().join("outside.png"), png).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git/secret.png"), png).unwrap();
        symlink(root.join("inside.png"), root.join("link.PNG")).unwrap();
        assert_eq!(image_file(root, "link.PNG").unwrap(), png);
        symlink(outside.path(), root.join("escape")).unwrap();
        symlink(outside.path().join("outside.png"), root.join("outside.png")).unwrap();
        symlink(root.join(".git/secret.png"), root.join("protected.png")).unwrap();
        for relative in [
            "../outside.png",
            "/etc/passwd",
            ".git/secret.png",
            "escape/outside.png",
            "outside.png",
            "protected.png",
        ] {
            assert!(
                matches!(image_file(root, relative), Err(FileError::InvalidPath)),
                "{relative}"
            );
        }
        fs::create_dir(root.join("directory.png")).unwrap();
        assert!(matches!(
            image_file(root, "directory.png"),
            Err(FileError::Unsupported)
        ));
        let fifo =
            std::ffi::CString::new(root.join("pipe.png").as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: the NUL-terminated path remains alive and points to an owned fixture directory.
        assert_eq!(unsafe { nix::libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(matches!(
            image_file(root, "pipe.png"),
            Err(FileError::Unsupported)
        ));
    }
    #[test]
    fn rejects_binary_invalid_encoding_and_oversized_files() {
        let folder = fixture();
        let root = folder.path();
        for (name, bytes) in [
            ("binary", vec![0]),
            ("encoding", vec![0xff]),
            ("large", vec![b'a'; MAX_BYTES as usize + 1]),
        ] {
            fs::write(root.join(name), bytes).unwrap();
            assert!(matches!(text_file(root, name), Err(FileError::Unsupported)));
        }
    }
    #[test]
    fn create_and_move_never_replace_existing_items() {
        let folder = fixture();
        let root = folder.path();
        operate(
            root,
            FileOperation::Create {
                path: "a".into(),
                directory: false,
            },
        )
        .unwrap();
        operate(
            root,
            FileOperation::Create {
                path: "b".into(),
                directory: true,
            },
        )
        .unwrap();
        assert!(matches!(
            operate(
                root,
                FileOperation::Create {
                    path: "a".into(),
                    directory: false
                }
            ),
            Err(FileError::Exists)
        ));
        assert!(operate(
            root,
            FileOperation::Move {
                from: "a".into(),
                to: "b".into()
            }
        )
        .is_err());
        assert!(operate(
            root,
            FileOperation::Move {
                from: "b".into(),
                to: "b/child".into()
            }
        )
        .is_err());
        operate(
            root,
            FileOperation::Move {
                from: "a".into(),
                to: "b/new".into(),
            },
        )
        .unwrap();
        assert!(root.join("b/new").is_file());
    }
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "moves an owned temporary fixture to the macOS Trash"]
    fn native_trash_preserves_a_symlinks_target() {
        let folder = fixture();
        let root = folder.path();
        fs::write(root.join("target"), "keep").unwrap();
        let name = format!("atte-files-trash-check-{}", Uuid::new_v4());
        std::os::unix::fs::symlink(root.join("target"), root.join(&name)).unwrap();
        operate(root, FileOperation::Trash { path: name.clone() }).unwrap();
        assert!(fs::symlink_metadata(root.join(name)).is_err());
        assert_eq!(fs::read_to_string(root.join("target")).unwrap(), "keep");
    }
}
