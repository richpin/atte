//! Read, save and open only content references already received in a thread.
use crate::thread::{content::ResponseContent, ThreadError, Threads};
use agent_client_protocol::schema::v1::{ContentBlock, EmbeddedResourceResource};
use std::path::PathBuf;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

fn failure(message: impl Into<String>) -> ThreadError {
    ThreadError::Unavailable(message.into())
}

#[tauri::command]
pub(crate) async fn read_response_content(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    content_id: String,
) -> Result<tauri::ipc::Response, ThreadError> {
    let content = threads.response_content(thread_id, &content_id)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || content.bytes())
        .await
        .map_err(|_| failure("contentUnavailable"))?
        .map_err(failure)?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err(failure("contentTooLarge"));
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub(crate) async fn save_response_content(
    app: tauri::AppHandle,
    thread_id: Uuid,
    content_id: String,
    dialog_title: String,
) -> Result<(), ThreadError> {
    let content = app
        .state::<Threads>()
        .response_content(thread_id, &content_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .set_title(dialog_title)
            .set_file_name(content.name())
            .blocking_save_file()
        else {
            return Ok(());
        };
        let path = path.into_path().map_err(|_| failure("contentSaveFailed"))?;
        let bytes = content.bytes().map_err(failure)?;
        std::fs::write(path, bytes).map_err(|_| failure("contentSaveFailed"))
    })
    .await
    .map_err(|_| failure("contentSaveFailed"))?
}

fn uri(content: &ResponseContent) -> Option<&str> {
    match content.0.as_ref() {
        ContentBlock::ResourceLink(link) => Some(&link.uri),
        ContentBlock::Resource(resource) => match &resource.resource {
            EmbeddedResourceResource::TextResourceContents(text) => Some(&text.uri),
            EmbeddedResourceResource::BlobResourceContents(blob) => Some(&blob.uri),
            _ => None,
        },
        _ => None,
    }
}

#[derive(Debug, PartialEq)]
enum FileTarget {
    Workspace(String),
    External(PathBuf),
}

fn file_target(root: PathBuf, content: &ResponseContent) -> Result<FileTarget, ThreadError> {
    let url = tauri::Url::parse(uri(content).ok_or_else(|| failure("invalidContentPath"))?)
        .map_err(|_| failure("invalidContentPath"))?;
    let file = url
        .to_file_path()
        .map_err(|_| failure("invalidContentPath"))?;
    let root = root
        .canonicalize()
        .map_err(|_| failure("invalidContentPath"))?;
    let file = file
        .canonicalize()
        .map_err(|_| failure("invalidContentPath"))?;
    if !file.is_file() || file.components().any(|part| part.as_os_str() == ".git") {
        return Err(failure("invalidContentPath"));
    }
    if let Ok(relative) = file.strip_prefix(&root) {
        let relative = relative
            .to_str()
            .ok_or_else(|| failure("invalidContentPath"))?;
        if crate::workspace_files::supports_preview(&root, relative)
            .map_err(|_| failure("contentOpenFailed"))?
        {
            return Ok(FileTarget::Workspace(relative.to_owned()));
        }
    }
    Ok(FileTarget::External(file))
}

#[tauri::command]
pub(crate) async fn open_response_file(
    threads: State<'_, Threads>,
    thread_id: Uuid,
    content_id: String,
) -> Result<Option<String>, ThreadError> {
    let content = threads.response_content(thread_id, &content_id)?;
    let root = threads.get(thread_id)?.working_folder;
    tauri::async_runtime::spawn_blocking(move || match file_target(root, &content)? {
        FileTarget::Workspace(relative) => Ok(Some(relative)),
        FileTarget::External(path) => {
            tauri_plugin_opener::open_path(path, None::<&str>)
                .map_err(|_| failure("contentOpenFailed"))?;
            Ok(None)
        }
    })
    .await
    .map_err(|_| failure("contentOpenFailed"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::ResourceLink;

    fn content(path: &std::path::Path) -> ResponseContent {
        ResponseContent::new(ContentBlock::ResourceLink(ResourceLink::new(
            "result",
            tauri::Url::from_file_path(path).unwrap().to_string(),
        )))
    }

    #[test]
    fn internal_previewable_files_use_files_and_external_files_use_the_os() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let path = root.path().join("result.html");
        std::fs::write(&path, "<h1>result</h1>").unwrap();
        assert_eq!(
            file_target(root.path().into(), &content(&path)).unwrap(),
            FileTarget::Workspace("result.html".into())
        );
        assert_eq!(
            file_target(root.path().into(), &content(outside.path())).unwrap(),
            FileTarget::External(outside.path().canonicalize().unwrap())
        );
    }

    #[test]
    fn internal_binary_and_oversized_files_use_the_os_but_images_stay_in_files() {
        let root = tempfile::tempdir().unwrap();
        for (name, bytes) in [
            ("report.pdf", b"%PDF-1.7".as_slice()),
            ("clip.wav", b"RIFF\0WAVE".as_slice()),
        ] {
            let path = root.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(
                file_target(root.path().into(), &content(&path)).unwrap(),
                FileTarget::External(path.canonicalize().unwrap())
            );
        }
        let image = root.path().join("preview.PNG");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\n").unwrap();
        assert_eq!(
            file_target(root.path().into(), &content(&image)).unwrap(),
            FileTarget::Workspace("preview.PNG".into())
        );
        let large = root.path().join("large.txt");
        std::fs::write(&large, vec![b'a'; 2 * 1024 * 1024 + 1]).unwrap();
        assert!(matches!(
            file_target(root.path().into(), &content(&large)).unwrap(),
            FileTarget::External(_)
        ));
    }

    #[test]
    fn missing_protected_and_non_file_links_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        assert!(file_target(root.path().into(), &content(&root.path().join("missing"))).is_err());
        assert!(file_target(root.path().into(), &content(root.path())).is_err());
        let git = root.path().join(".git");
        std::fs::create_dir(&git).unwrap();
        let config = git.join("config");
        std::fs::write(&config, "protected").unwrap();
        assert!(file_target(root.path().into(), &content(&config)).is_err());
        let web = ResponseContent::new(ContentBlock::ResourceLink(ResourceLink::new(
            "web",
            "https://example.com",
        )));
        assert!(file_target(root.path().into(), &web).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_routed_by_their_actual_destination() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let link = root.path().join("outside.txt");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        assert_eq!(
            file_target(root.path().into(), &content(&link)).unwrap(),
            FileTarget::External(outside.path().canonicalize().unwrap())
        );
    }
}
