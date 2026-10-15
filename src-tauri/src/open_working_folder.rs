//! Discovers native applications for a thread's working folder.
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;

use crate::thread::Threads;

#[derive(Debug, Serialize)]
pub(crate) struct WorkingFolderApp {
    id: String,
    name: String,
    icon: Option<String>,
}

#[derive(Debug, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OpenFolderError {
    #[error("The thread is unavailable")]
    ThreadUnavailable,
    #[error("The working folder does not exist")]
    FolderMissing,
    #[error("The application is no longer available for this folder")]
    AppMissing,
    #[error("Choose a valid macOS application")]
    InvalidApplication,
    #[error("Application discovery failed")]
    DiscoveryFailed,
    #[error("The folder could not be opened")]
    OpenFailed,
    #[cfg(not(target_os = "macos"))]
    #[error("This platform is not supported")]
    UnsupportedPlatform,
}

fn working_folder(threads: &Threads, id: Uuid) -> Result<PathBuf, OpenFolderError> {
    let folder = threads
        .get(id)
        .map_err(|_| OpenFolderError::ThreadUnavailable)?
        .working_folder;
    if !folder.is_dir() {
        return Err(OpenFolderError::FolderMissing);
    }
    Ok(folder)
}

fn select_application(applications: Vec<PathBuf>, id: &str) -> Result<PathBuf, OpenFolderError> {
    applications
        .into_iter()
        .find(|path| path.to_str() == Some(id))
        .ok_or(OpenFolderError::AppMissing)
}

#[tauri::command]
pub(crate) async fn list_working_folder_apps(
    app: tauri::AppHandle,
    threads: State<'_, Threads>,
    thread_id: Uuid,
) -> Result<Vec<WorkingFolderApp>, OpenFolderError> {
    #[cfg(target_os = "macos")]
    {
        let folder = working_folder(&threads, thread_id)?;
        let (send, receive) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let result = macos::applications(&folder).and_then(|applications| {
                applications.into_iter().map(macos::app_metadata).collect()
            });
            let _ = send.send(result);
        })
        .map_err(|_| OpenFolderError::DiscoveryFailed)?;
        receive
            .await
            .map_err(|_| OpenFolderError::DiscoveryFailed)?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, threads, thread_id);
        Err(OpenFolderError::UnsupportedPlatform)
    }
}

#[tauri::command]
pub(crate) async fn open_working_folder(
    app: tauri::AppHandle,
    threads: State<'_, Threads>,
    thread_id: Uuid,
    target: String,
) -> Result<(), OpenFolderError> {
    #[cfg(target_os = "macos")]
    {
        let folder = working_folder(&threads, thread_id)?;
        let (send, receive) = tokio::sync::oneshot::channel();
        let lookup_folder = folder.clone();
        app.run_on_main_thread(move || {
            let result = macos::applications(&lookup_folder)
                .and_then(|applications| select_application(applications, &target));
            let _ = send.send(result);
        })
        .map_err(|_| OpenFolderError::DiscoveryFailed)?;
        let application = receive
            .await
            .map_err(|_| OpenFolderError::DiscoveryFailed)??;
        tauri::async_runtime::spawn_blocking(move || {
            let application = application.to_str().ok_or(OpenFolderError::AppMissing)?;
            tauri_plugin_opener::open_path(folder, Some(application))
                .map_err(|_| OpenFolderError::OpenFailed)
        })
        .await
        .map_err(|_| OpenFolderError::OpenFailed)?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, threads, thread_id, target);
        Err(OpenFolderError::UnsupportedPlatform)
    }
}

#[tauri::command]
pub(crate) async fn open_working_folder_with_app_picker(
    app: tauri::AppHandle,
    threads: State<'_, Threads>,
    thread_id: Uuid,
    dialog_title: String,
) -> Result<(), OpenFolderError> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_dialog::DialogExt;

        working_folder(&threads, thread_id)?;
        let dialog_app = app.clone();
        let selected = tauri::async_runtime::spawn_blocking(move || {
            dialog_app
                .dialog()
                .file()
                .set_title(dialog_title)
                .add_filter("Applications", &["app"])
                .set_directory("/Applications")
                .blocking_pick_file()
        })
        .await
        .map_err(|_| OpenFolderError::OpenFailed)?;
        let Some(selected) = selected else {
            return Ok(());
        };
        let application = selected
            .into_path()
            .map_err(|_| OpenFolderError::InvalidApplication)?;
        // The native picker authorizes this application, even if it isn't an OS
        // folder handler. No application path is accepted from the frontend.
        let application = macos::validate_application(&application)?;
        let folder = working_folder(&threads, thread_id)?;
        tauri::async_runtime::spawn_blocking(move || {
            let application = application
                .to_str()
                .ok_or(OpenFolderError::InvalidApplication)?;
            tauri_plugin_opener::open_path(folder, Some(application))
                .map_err(|_| OpenFolderError::OpenFailed)
        })
        .await
        .map_err(|_| OpenFolderError::OpenFailed)?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, threads, thread_id, dialog_title);
        Err(OpenFolderError::UnsupportedPlatform)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{OpenFolderError, WorkingFolderApp};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use objc2::{runtime::NSObjectProtocol, sel, AllocAnyThread};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext,
        NSWorkspace,
    };
    use objc2_foundation::{
        NSBundle, NSDictionary, NSFileManager, NSPoint, NSRect, NSSize, NSString, NSURL,
    };
    use std::path::{Path, PathBuf};

    pub(super) fn validate_application(path: &Path) -> Result<PathBuf, OpenFolderError> {
        if path.extension().and_then(|extension| extension.to_str()) != Some("app")
            || !path.is_dir()
        {
            return Err(OpenFolderError::InvalidApplication);
        }
        let url = NSURL::from_file_path(path).ok_or(OpenFolderError::InvalidApplication)?;
        let bundle = NSBundle::bundleWithURL(&url).ok_or(OpenFolderError::InvalidApplication)?;
        let package_type =
            bundle.objectForInfoDictionaryKey(&NSString::from_str("CFBundlePackageType"));
        let is_application = package_type
            .as_ref()
            .and_then(|value| value.downcast_ref::<NSString>())
            .is_some_and(|value| value.to_string() == "APPL");
        let executable_exists = bundle
            .executableURL()
            .and_then(|url| url.to_file_path())
            .is_some_and(|executable| executable.is_file());
        if !is_application || !executable_exists {
            return Err(OpenFolderError::InvalidApplication);
        }
        Ok(path.to_owned())
    }

    pub(super) fn applications(folder: &Path) -> Result<Vec<PathBuf>, OpenFolderError> {
        let workspace = NSWorkspace::sharedWorkspace();
        // The application-list API was introduced in macOS 12. Fail discovery
        // normally on older systems instead of sending an unknown selector.
        if !workspace.respondsToSelector(sel!(URLsForApplicationsToOpenURL:)) {
            return Err(OpenFolderError::DiscoveryFailed);
        }
        let url = NSURL::from_file_path(folder).ok_or(OpenFolderError::DiscoveryFailed)?;
        workspace
            .URLsForApplicationsToOpenURL(&url)
            .iter()
            .map(|url| url.to_file_path().ok_or(OpenFolderError::DiscoveryFailed))
            .collect()
    }

    pub(super) fn app_metadata(path: PathBuf) -> Result<WorkingFolderApp, OpenFolderError> {
        let id = path
            .to_str()
            .ok_or(OpenFolderError::DiscoveryFailed)?
            .to_owned();
        let name = NSFileManager::defaultManager()
            .displayNameAtPath(&NSString::from_str(&id))
            .to_string();
        Ok(WorkingFolderApp {
            name: name.strip_suffix(".app").unwrap_or(&name).to_owned(),
            icon: icon(&id),
            id,
        })
    }

    fn icon(path: &str) -> Option<String> {
        let image = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path));
        // SAFETY: null planes asks AppKit to allocate its own 32x32 RGBA buffer.
        // All AppKit access stays in the main-thread command callback.
        let bitmap = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(), std::ptr::null_mut(), 32, 32, 8, 4,
                true, false, NSDeviceRGBColorSpace, 0, 0,
            )
        }?;
        let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)?;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&context));
        image.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(32.0, 32.0)));
        NSGraphicsContext::restoreGraphicsState_class();
        // SAFETY: an empty properties dictionary requests default PNG encoding.
        let data = unsafe {
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }?;
        Some(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(data.to_vec())
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn accepts_a_native_application_bundle_selected_by_the_user() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("Selected App.app");
        std::fs::create_dir_all(path.join("Contents/MacOS")).unwrap();
        std::fs::write(path.join("Contents/Info.plist"), r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>fixture</string></dict></plist>"#).unwrap();
        std::fs::write(path.join("Contents/MacOS/fixture"), b"fixture").unwrap();
        assert_eq!(macos::validate_application(&path).unwrap(), path);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_an_empty_directory_disguised_as_an_application() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("Invalid.app");
        std::fs::create_dir(&path).unwrap();
        assert!(matches!(
            macos::validate_application(&path),
            Err(OpenFolderError::InvalidApplication)
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_a_regular_file_instead_of_an_application() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("Invalid.app");
        std::fs::write(&path, b"not a bundle").unwrap();
        assert!(matches!(
            macos::validate_application(&path),
            Err(OpenFolderError::InvalidApplication)
        ));
    }

    #[test]
    fn selects_an_os_discovered_application() {
        let path = PathBuf::from("/Applications/Unlisted Editor.app");
        let applications = vec![PathBuf::from("/Applications/Other.app"), path.clone()];
        assert_eq!(
            select_application(applications, path.to_str().unwrap()).unwrap(),
            path
        );
    }

    #[test]
    fn rejects_an_application_not_returned_by_the_os() {
        let applications = vec![PathBuf::from("/Applications/Unlisted Editor.app")];
        assert!(matches!(
            select_application(applications, "/Applications/Calculator.app"),
            Err(OpenFolderError::AppMissing)
        ));
    }

    #[test]
    fn rejects_an_application_when_the_os_returns_no_handlers() {
        assert!(matches!(
            select_application(vec![], "/Applications/Editor.app"),
            Err(OpenFolderError::AppMissing)
        ));
    }

    #[test]
    fn keeps_the_working_folder_when_it_contains_project_documents() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("App.xcworkspace")).unwrap();
        std::fs::create_dir(root.path().join("App.xcodeproj")).unwrap();
        let threads = Threads::new(vec![crate::agent::prepared_codex()]);
        let thread = threads.create(root.path()).unwrap();
        assert_eq!(
            working_folder(&threads, thread.id).unwrap(),
            root.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn rejects_an_unknown_thread() {
        let threads = Threads::new(Vec::new());
        assert!(matches!(
            working_folder(&threads, Uuid::new_v4()),
            Err(OpenFolderError::ThreadUnavailable)
        ));
    }

    #[test]
    fn preserves_spaces_and_unicode_in_the_working_folder() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("한글 project");
        std::fs::create_dir(&folder).unwrap();
        let threads = Threads::new(vec![crate::agent::prepared_codex()]);
        let thread = threads.create(&folder).unwrap();
        assert_eq!(
            working_folder(&threads, thread.id).unwrap(),
            folder.canonicalize().unwrap()
        );
    }

    #[test]
    fn reports_a_folder_removed_after_thread_creation() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("removed");
        std::fs::create_dir(&folder).unwrap();
        let threads = Threads::new(vec![crate::agent::prepared_codex()]);
        let thread = threads.create(&folder).unwrap();
        std::fs::remove_dir(folder).unwrap();
        assert!(matches!(
            working_folder(&threads, thread.id),
            Err(OpenFolderError::FolderMissing)
        ));
    }
}
