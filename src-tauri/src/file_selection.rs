use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::thread::{Attachment, MediaKind, ThreadError, UserInput};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileSelection {
    pub(crate) attachments: Vec<Attachment>,
    pub(crate) errors: Vec<FileSelectionError>,
}

#[derive(Debug, Serialize)]
pub(crate) struct FileSelectionError {
    pub(crate) name: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SubmittedInput {
    pub(crate) text: String,
    pub(crate) attachments: Vec<Uuid>,
}

struct SelectedFile {
    owner: String,
    thread: Uuid,
    attachment: Attachment,
}

#[derive(Default)]
pub(crate) struct SelectedFiles(Mutex<HashMap<Uuid, SelectedFile>>);

impl SelectedFiles {
    pub(crate) fn remember(
        &self,
        owner: &str,
        thread: Uuid,
        selection: &FileSelection,
    ) -> Result<(), ThreadError> {
        let mut selected = self.0.lock().map_err(|_| unavailable())?;
        selected.extend(selection.attachments.iter().cloned().map(|attachment| {
            (
                attachment.id,
                SelectedFile {
                    owner: owner.into(),
                    thread,
                    attachment,
                },
            )
        }));
        Ok(())
    }

    pub(crate) fn resolve(
        &self,
        owner: &str,
        thread: Uuid,
        submitted: &SubmittedInput,
    ) -> Result<UserInput, ThreadError> {
        let selected = self.0.lock().map_err(|_| unavailable())?;
        let attachments = submitted
            .attachments
            .iter()
            .map(|id| {
                selected
                    .get(id)
                    .filter(|selected| selected.owner == owner && selected.thread == thread)
                    .map(|selected| selected.attachment.clone())
                    .ok_or_else(invalid_attachment)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(UserInput {
            body: submitted.text.clone(),
            attachments,
        })
    }

    pub(crate) fn forget(&self, owner: &str, ids: &[Uuid]) -> Vec<(Uuid, Attachment)> {
        let mut selected = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut forgotten = Vec::new();
        for id in ids {
            if selected
                .get(id)
                .is_some_and(|selected| selected.owner == owner)
            {
                if let Some(selected) = selected.remove(id) {
                    forgotten.push((selected.thread, selected.attachment));
                }
            }
        }
        forgotten
    }

    pub(crate) fn forget_owner(&self, owner: &str) -> Vec<(Uuid, Attachment)> {
        let mut selected = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let ids = selected
            .iter()
            .filter(|(_, selected)| selected.owner == owner)
            .map(|(id, _)| *id)
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| selected.remove(&id))
            .map(|selected| (selected.thread, selected.attachment))
            .collect()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct MediaStore {
    root: PathBuf,
    active: Arc<Mutex<HashSet<(Uuid, Uuid)>>>,
}

impl MediaStore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            active: Arc::default(),
        }
    }

    pub(crate) fn snapshot(
        &self,
        thread: Uuid,
        name: String,
        requested: MediaKind,
        bytes: &[u8],
        declared_mime: Option<&str>,
    ) -> Result<Attachment, ThreadError> {
        let name = display_name(Path::new(&name));
        let mime_type = media_type(&name, requested, bytes, declared_mime)
            .ok_or_else(|| ThreadError::InvalidMessage(invalid_media_message(requested)))?;
        let id = Uuid::new_v4();
        let directory = self.thread_directory(thread);
        std::fs::create_dir_all(&directory).map_err(|_| snapshot_unavailable())?;
        let temporary = directory.join(format!(".{id}.tmp"));
        let destination = directory.join(id.to_string());
        if let Err(error) = std::fs::write(&temporary, bytes)
            .and_then(|()| std::fs::rename(&temporary, &destination))
        {
            let _ = std::fs::remove_file(temporary);
            return Err(ThreadError::Unavailable(error.to_string()));
        }
        self.active
            .lock()
            .map_err(|_| snapshot_unavailable())?
            .insert((thread, id));
        Ok(Attachment::media(id, name, requested, mime_type))
    }

    pub(crate) fn read(&self, thread: Uuid, attachment: Uuid) -> Result<Vec<u8>, ThreadError> {
        std::fs::read(self.path(thread, attachment)).map_err(|_| snapshot_unavailable())
    }

    pub(crate) fn remove(&self, thread: Uuid, attachments: impl IntoIterator<Item = Uuid>) {
        for attachment in attachments {
            let _ = std::fs::remove_file(self.path(thread, attachment));
            if let Ok(mut active) = self.active.lock() {
                active.remove(&(thread, attachment));
            }
        }
        let _ = std::fs::remove_dir(self.thread_directory(thread));
    }

    pub(crate) fn cleanup_orphans(&self, thread: Uuid, referenced: impl IntoIterator<Item = Uuid>) {
        let referenced = referenced.into_iter().collect::<HashSet<_>>();
        let active = self.active.lock().ok();
        let directory = self.thread_directory(thread);
        let Ok(entries) = std::fs::read_dir(&directory) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let id = name.to_str().and_then(|name| Uuid::parse_str(name).ok());
            let keep = id.is_some_and(|id| {
                referenced.contains(&id)
                    || active
                        .as_ref()
                        .is_some_and(|active| active.contains(&(thread, id)))
            });
            if !keep && entry.file_type().is_ok_and(|kind| kind.is_file()) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let _ = std::fs::remove_dir(directory);
    }

    fn path(&self, thread: Uuid, attachment: Uuid) -> PathBuf {
        self.thread_directory(thread).join(attachment.to_string())
    }

    fn thread_directory(&self, thread: Uuid) -> PathBuf {
        self.root.join(thread.to_string())
    }
}

pub(crate) fn prepare_file_selection(paths: impl IntoIterator<Item = PathBuf>) -> FileSelection {
    let mut result = FileSelection {
        attachments: Vec::new(),
        errors: Vec::new(),
    };
    for path in paths {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "선택한 파일".into());
        let prepared = std::fs::canonicalize(&path).ok().and_then(|canonical| {
            canonical
                .metadata()
                .ok()
                .filter(|metadata| metadata.is_file())
                .and_then(|_| tauri::Url::from_file_path(canonical).ok())
        });
        if let Some(uri) = prepared {
            result
                .attachments
                .push(Attachment::file(Uuid::new_v4(), name, uri.to_string()));
        } else {
            result.errors.push(FileSelectionError { name });
        }
    }
    result
}

pub(crate) fn prepare_media_selection(
    paths: impl IntoIterator<Item = PathBuf>,
    thread: Uuid,
    requested: MediaKind,
    store: &MediaStore,
) -> FileSelection {
    let mut result = FileSelection {
        attachments: Vec::new(),
        errors: Vec::new(),
    };
    for path in paths {
        let name = display_name(&path);
        let prepared = std::fs::canonicalize(&path)
            .ok()
            .filter(|canonical| {
                canonical
                    .metadata()
                    .is_ok_and(|metadata| metadata.is_file())
            })
            .and_then(|canonical| std::fs::read(canonical).ok())
            .and_then(|bytes| {
                store
                    .snapshot(thread, name.clone(), requested, &bytes, None)
                    .ok()
            });
        if let Some(attachment) = prepared {
            result.attachments.push(attachment);
        } else {
            result.errors.push(FileSelectionError { name });
        }
    }
    result
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "선택한 파일".into())
}

fn media_type(
    name: &str,
    requested: MediaKind,
    bytes: &[u8],
    declared_mime: Option<&str>,
) -> Option<String> {
    if let Some(detected) = infer::get(bytes) {
        return matches_requested(detected.mime_type(), requested)
            .then(|| detected.mime_type().to_owned());
    }
    extension_mime(name, requested)
        .or_else(|| declared_mime.filter(|mime| matches_requested(mime, requested)))
        .map(str::to_owned)
}

fn extension_mime(name: &str, requested: MediaKind) -> Option<&'static str> {
    let extension = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "avif" => "image/avif",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "opus" => "audio/opus",
        "aiff" | "aif" => "audio/aiff",
        _ => return None,
    };
    matches_requested(mime, requested).then_some(mime)
}

fn matches_requested(mime: &str, requested: MediaKind) -> bool {
    match requested {
        MediaKind::Image => mime.starts_with("image/"),
        MediaKind::Audio => mime.starts_with("audio/"),
    }
}

fn invalid_media_message(kind: MediaKind) -> String {
    match kind {
        MediaKind::Image => "이미지 파일을 선택해주세요.",
        MediaKind::Audio => "오디오 파일을 선택해주세요.",
    }
    .into()
}

fn snapshot_unavailable() -> ThreadError {
    ThreadError::Unavailable("첨부 내용을 저장하거나 불러올 수 없습니다.".into())
}

fn invalid_attachment() -> ThreadError {
    ThreadError::InvalidMessage("첨부 파일을 다시 선택해주세요.".into())
}

fn unavailable() -> ThreadError {
    ThreadError::Unavailable("선택한 파일을 사용할 수 없습니다.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepares_a_regular_file_with_its_canonical_uri() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("a file.png");
        std::fs::write(&file, "image-shaped bytes").unwrap();

        let selection = prepare_file_selection([file]);

        assert_eq!(
            (
                selection.attachments[0].name.as_str(),
                selection.attachments[0]
                    .uri
                    .as_deref()
                    .is_some_and(|uri| uri.ends_with("/a%20file.png")),
            ),
            ("a file.png", true)
        );
    }

    #[test]
    fn reports_a_directory_as_an_individual_error() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("folder");
        std::fs::create_dir(&directory).unwrap();

        let selection = prepare_file_selection([directory]);

        assert_eq!(selection.errors[0].name, "folder");
    }

    #[test]
    fn reports_a_missing_file_as_an_individual_error() {
        let root = tempfile::tempdir().unwrap();

        let selection = prepare_file_selection([root.path().join("missing.txt")]);

        assert_eq!(selection.errors[0].name, "missing.txt");
    }

    #[test]
    fn resolves_only_attachments_issued_by_file_selection() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "notes").unwrap();
        let selection = prepare_file_selection([file]);
        let selected = SelectedFiles::default();
        let thread = Uuid::new_v4();
        selected.remember("main", thread, &selection).unwrap();
        let submitted = SubmittedInput {
            text: "read this".into(),
            attachments: vec![selection.attachments[0].id],
        };

        let resolved = selected.resolve("main", thread, &submitted).unwrap();

        assert_eq!(resolved.attachments, selection.attachments);
    }

    #[test]
    fn rejects_an_attachment_id_that_was_not_issued() {
        let selected = SelectedFiles::default();
        let submitted = SubmittedInput {
            text: String::new(),
            attachments: vec![Uuid::new_v4()],
        };

        let result = selected.resolve("main", Uuid::new_v4(), &submitted);

        assert!(matches!(result, Err(ThreadError::InvalidMessage(_))));
    }

    #[test]
    fn resolves_remembered_metadata_after_the_source_is_deleted() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("ephemeral.txt");
        std::fs::write(&file, "temporary").unwrap();
        let selection = prepare_file_selection([file.clone()]);
        let selected = SelectedFiles::default();
        let thread = Uuid::new_v4();
        selected.remember("main", thread, &selection).unwrap();
        std::fs::remove_file(file).unwrap();
        let submitted = SubmittedInput {
            text: String::new(),
            attachments: vec![selection.attachments[0].id],
        };

        let resolved = selected.resolve("main", thread, &submitted).unwrap();

        assert_eq!(resolved.attachments, selection.attachments);
    }

    #[test]
    fn releases_a_removed_selection_for_the_owning_window() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "notes").unwrap();
        let selection = prepare_file_selection([file]);
        let selected = SelectedFiles::default();
        let thread = Uuid::new_v4();
        selected.remember("main", thread, &selection).unwrap();

        selected.forget("main", &[selection.attachments[0].id]);

        let submitted = SubmittedInput {
            text: String::new(),
            attachments: vec![selection.attachments[0].id],
        };
        assert!(matches!(
            selected.resolve("main", thread, &submitted),
            Err(ThreadError::InvalidMessage(_))
        ));
    }

    #[test]
    fn releases_abandoned_selections_when_the_owning_window_closes() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "notes").unwrap();
        let selection = prepare_file_selection([file]);
        let selected = SelectedFiles::default();
        let thread = Uuid::new_v4();
        selected.remember("main", thread, &selection).unwrap();

        selected.forget_owner("main");

        let submitted = SubmittedInput {
            text: String::new(),
            attachments: vec![selection.attachments[0].id],
        };
        assert!(matches!(
            selected.resolve("main", thread, &submitted),
            Err(ThreadError::InvalidMessage(_))
        ));
    }

    #[test]
    fn snapshots_exact_image_bytes_and_rejects_audio_magic() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("photo.jpg");
        let bytes = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4];
        std::fs::write(&source, bytes).unwrap();
        let store = MediaStore::new(root.path().join("snapshots"));
        let thread = Uuid::new_v4();

        let image = prepare_media_selection([source.clone()], thread, MediaKind::Image, &store);
        let audio = prepare_media_selection([source], thread, MediaKind::Audio, &store);
        std::fs::write(root.path().join("photo.jpg"), [9, 9, 9]).unwrap();

        assert_eq!(store.read(thread, image.attachments[0].id).unwrap(), bytes);
        assert_eq!(audio.errors[0].name, "photo.jpg");
    }

    #[test]
    fn uses_extension_only_when_magic_bytes_are_unknown() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("diagram.svg");
        std::fs::write(&source, b"<svg></svg>").unwrap();
        let store = MediaStore::new(root.path().join("snapshots"));
        let thread = Uuid::new_v4();

        let selection = prepare_media_selection([source], thread, MediaKind::Image, &store);

        assert_eq!(
            selection.attachments[0].mime_type.as_deref(),
            Some("image/svg+xml")
        );
    }

    #[test]
    fn keeps_valid_media_when_another_selected_file_is_invalid() {
        let root = tempfile::tempdir().unwrap();
        let image = root.path().join("photo.png");
        let invalid = root.path().join("notes.txt");
        std::fs::write(&image, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
        std::fs::write(&invalid, "notes").unwrap();
        let store = MediaStore::new(root.path().join("snapshots"));

        let selection =
            prepare_media_selection([invalid, image], Uuid::new_v4(), MediaKind::Image, &store);

        assert_eq!(
            (
                selection.errors[0].name.as_str(),
                selection.attachments[0].name.as_str(),
            ),
            ("notes.txt", "photo.png")
        );
    }

    #[test]
    fn cleans_only_unreferenced_snapshots_for_one_thread() {
        let root = tempfile::tempdir().unwrap();
        let store = MediaStore::new(root.path().join("snapshots"));
        let thread = Uuid::new_v4();
        let other_thread = Uuid::new_v4();
        let kept = store
            .snapshot(
                thread,
                "kept.png".into(),
                MediaKind::Image,
                &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
                None,
            )
            .unwrap();
        let orphan = Uuid::new_v4();
        std::fs::write(
            root.path()
                .join("snapshots")
                .join(thread.to_string())
                .join(orphan.to_string()),
            [1],
        )
        .unwrap();
        let other = store
            .snapshot(
                other_thread,
                "other.png".into(),
                MediaKind::Image,
                &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
                None,
            )
            .unwrap();
        let active_draft = store
            .snapshot(
                thread,
                "draft.png".into(),
                MediaKind::Image,
                &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
                None,
            )
            .unwrap();

        store.cleanup_orphans(thread, [kept.id]);

        assert!(store.read(thread, kept.id).is_ok());
        assert!(store.read(thread, active_draft.id).is_ok());
        assert!(store.read(thread, orphan).is_err());
        assert!(store.read(other_thread, other.id).is_ok());
    }
}
