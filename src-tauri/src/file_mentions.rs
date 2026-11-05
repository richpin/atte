//! File mentions are validated and snapshotted at submission, never in the WebView.
use crate::thread::{Attachment, ThreadError, Threads, UserInput};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    path::{Component, Path},
};
use uuid::Uuid;

const FILE_LIMIT: u64 = 20 * 1024 * 1024;
const INPUT_LIMIT: u64 = 50 * 1024 * 1024;

/// A selected file occurrence, measured in UTF-16 code units of the message body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMention {
    pub id: Uuid,
    pub path: String,
    pub start: usize,
    pub end: usize,
    pub order: usize,
}

/// File-level prompt metadata sharing one optional snapshot across all occurrences.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileResource {
    pub path: String,
    pub mentions: Vec<FileMention>,
    pub embedded: bool,
    pub text: bool,
}

fn invalid() -> ThreadError {
    ThreadError::InvalidMessage("유효하지 않은 파일 멘션입니다.".into())
}

// Check existing ancestors as well as the leaf, including broken/missing paths. Missing
// files may become links, but a symlink pointing outside the workspace must never do so.
fn target(root: &Path, relative: &str) -> Result<std::path::PathBuf, ThreadError> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path.components().any(
            |c| !matches!(c, Component::Normal(name) if crate::platform::valid_component(name)),
        )
        || path.components().any(|c| {
            c.as_os_str() == ".git"
                || (cfg!(windows) && c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))
        })
    {
        return Err(invalid());
    }
    let mut resolved = root.to_path_buf();
    for part in path.components() {
        resolved.push(part);
        if let Ok(metadata) = std::fs::symlink_metadata(&resolved) {
            if metadata.file_type().is_symlink() {
                resolved = resolved.canonicalize().map_err(|_| invalid())?;
            }
            if !resolved.starts_with(root) {
                return Err(invalid());
            }
        }
    }
    Ok(resolved)
}

fn bytes(path: &Path, remaining: u64) -> Option<Vec<u8>> {
    let file = crate::platform::open_no_follow(path).ok()?;
    let metadata = file.metadata().ok()?;
    let limit = FILE_LIMIT.min(remaining);
    if !metadata.is_file() || metadata.len() > limit {
        return None;
    }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data).ok()?;
    (data.len() as u64 <= limit).then_some(data)
}

pub(crate) fn prepare(
    threads: &Threads,
    thread: Uuid,
    input: UserInput,
    mentions: Vec<FileMention>,
) -> Result<UserInput, ThreadError> {
    if mentions.is_empty() {
        return Ok(input);
    }
    let current = threads.get(thread)?;
    let root = current
        .working_folder
        .canonicalize()
        .map_err(|_| invalid())?;
    prepare_files(
        &root,
        threads.media_store().as_deref(),
        current.prompt_capabilities.embedded_context,
        thread,
        input,
        mentions,
    )
}

fn prepare_files(
    root: &Path,
    store: Option<&crate::file_selection::MediaStore>,
    supported: bool,
    thread: Uuid,
    mut input: UserInput,
    mut mentions: Vec<FileMention>,
) -> Result<UserInput, ThreadError> {
    let body: Vec<u16> = input.body.encode_utf16().collect();
    let mut ranges = mentions.iter().collect::<Vec<_>>();
    ranges.sort_by_key(|m| m.start);
    let mut end = 0;
    let mut targets = HashMap::new();
    for mention in &ranges {
        if mention.start < end
            || mention.end <= mention.start
            || mention.end > body.len()
            || body[mention.start..mention.end]
                != format!("@{}", mention.path)
                    .encode_utf16()
                    .collect::<Vec<_>>()
        {
            return Err(invalid());
        }
        end = mention.end;
        targets.insert(mention.path.clone(), target(root, &mention.path)?);
    }
    mentions.sort_by_key(|m| m.order);
    let mut total = 0;
    let mut attachments: Vec<Attachment> = Vec::new();
    for mention in mentions {
        if let Some(existing) = attachments
            .iter_mut()
            .find(|a| a.resource.as_ref().is_some_and(|r| r.path == mention.path))
        {
            if let Some(resource) = &mut existing.resource {
                resource.mentions.push(mention);
            }
            continue;
        }
        let path = &targets[&mention.path];
        let uri = tauri::Url::from_file_path(root.join(&mention.path))
            .map_err(|_| invalid())?
            .to_string();
        let mut attachment = Attachment::file(
            Uuid::new_v4(),
            path.file_name().unwrap_or_default().to_string_lossy(),
            uri,
        );
        let mut resource = FileResource {
            path: mention.path.clone(),
            mentions: vec![mention],
            embedded: false,
            text: false,
        };
        if supported {
            if let (Some(store), Some(data)) = (store, bytes(path, INPUT_LIMIT - total)) {
                resource.text = std::str::from_utf8(&data).is_ok() && !data.contains(&0);
                attachment.mime_type = Some(if resource.text {
                    "text/plain".into()
                } else {
                    infer::get(&data)
                        .map(|t| t.mime_type())
                        .unwrap_or("application/octet-stream")
                        .into()
                });
                if store.snapshot_bytes(thread, attachment.id, &data).is_ok() {
                    total += data.len() as u64;
                    resource.embedded = true;
                }
            }
        }
        attachment.resource = Some(resource);
        attachments.push(attachment);
    }
    input.attachments.extend(attachments);
    Ok(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn rejects_escape_and_git_but_allows_missing_files() {
        let root = tempfile::tempdir().unwrap();
        assert!(target(root.path(), "../secret").is_err());
        assert!(target(root.path(), ".git/config").is_err());
        assert!(target(root.path(), "missing/file.txt").is_ok());
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("outside")).unwrap();
        assert!(target(root.path(), "outside/missing.txt").is_err());
    }
    #[test]
    fn reads_text_and_binary_with_exact_size_boundary() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("file");
        std::fs::write(&path, [0, 1, 2, 3]).unwrap();
        assert_eq!(bytes(&path, 4), Some(vec![0, 1, 2, 3]));
        assert_eq!(bytes(&path, 3), None);
    }
}

#[cfg(test)]
mod preparation_tests {
    use super::*;
    use crate::file_selection::MediaStore;

    fn input(paths: &[&str]) -> (UserInput, Vec<FileMention>) {
        let mut input = UserInput::default();
        let mut mentions = Vec::new();
        for (order, path) in paths.iter().enumerate() {
            if order > 0 {
                input.body.push(' ');
            }
            let start = input.body.encode_utf16().count();
            input.body.push_str(&format!("@{path}"));
            mentions.push(FileMention {
                id: Uuid::new_v4(),
                path: (*path).into(),
                start,
                end: input.body.encode_utf16().count(),
                order,
            });
        }
        (input, mentions)
    }

    #[test]
    fn snapshots_latest_text_and_binary_once_and_survives_store_reopen() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let store = MediaStore::new(storage.path().into());
        let thread = Uuid::new_v4();
        std::fs::write(root.join("한글.txt"), "latest").unwrap();
        std::fs::write(root.join("binary"), [0, 1, 255]).unwrap();
        let (input, mentions) = input(&["한글.txt", "binary", "한글.txt"]);
        let prepared = prepare_files(&root, Some(&store), true, thread, input, mentions).unwrap();
        assert_eq!(prepared.attachments.len(), 2);
        let text = &prepared.attachments[0];
        let resource = text.resource.as_ref().unwrap();
        assert!(resource.embedded && resource.text);
        assert_eq!(resource.mentions.len(), 2);
        assert!(!prepared.attachments[1].resource.as_ref().unwrap().text);
        std::fs::write(root.join("한글.txt"), "changed after submit").unwrap();
        let reopened = MediaStore::new(storage.path().into());
        assert_eq!(reopened.read(thread, text.id).unwrap(), b"latest");
        store.remove(thread, prepared.attachments.iter().map(|a| a.id));
        assert!(reopened.read(thread, text.id).is_err());
    }

    #[test]
    fn falls_back_for_missing_unsupported_and_oversized_files() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        let store = MediaStore::new(root.join("snapshots"));
        std::fs::File::create(root.join("large"))
            .unwrap()
            .set_len(FILE_LIMIT + 1)
            .unwrap();
        let (input, mentions) = input(&["missing", "large"]);
        let prepared = prepare_files(
            &root,
            Some(&store),
            true,
            Uuid::new_v4(),
            input.clone(),
            mentions.clone(),
        )
        .unwrap();
        assert!(prepared
            .attachments
            .iter()
            .all(|a| !a.has_snapshot() && a.uri.is_some()));
        let unsupported =
            prepare_files(&root, Some(&store), false, Uuid::new_v4(), input, mentions).unwrap();
        assert!(unsupported.attachments.iter().all(|a| !a.has_snapshot()));
    }

    #[test]
    fn enforces_total_budget_in_selection_order_without_charging_duplicates() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let store = MediaStore::new(storage.path().into());
        for name in ["a", "b", "c"] {
            std::fs::File::create(root.join(name))
                .unwrap()
                .set_len(FILE_LIMIT)
                .unwrap();
        }
        let (input, mentions) = input(&["a", "a", "b", "c"]);
        let prepared =
            prepare_files(&root, Some(&store), true, Uuid::new_v4(), input, mentions).unwrap();
        assert!(prepared.attachments[0].has_snapshot());
        assert!(prepared.attachments[1].has_snapshot());
        assert!(!prepared.attachments[2].has_snapshot());
    }

    #[test]
    fn rejects_forged_ranges_before_creating_snapshots() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        let (input, mut mentions) = input(&["a"]);
        mentions[0].end += 1;
        assert!(prepare_files(&root, None, true, Uuid::new_v4(), input, mentions).is_err());
    }
}
