//! Discovers native applications for a thread's folder and project documents.
use serde::Serialize;
use std::path::{Path, PathBuf};
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
    #[error("The application is no longer available for this project")]
    AppMissing,
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

// Only inspect the chosen folder's immediate children. Workspaces take precedence
// over projects so a CocoaPods workspace opens with its dependencies intact.
fn project_documents(folder: &Path) -> Result<Vec<PathBuf>, OpenFolderError> {
    if matches!(
        folder.extension().and_then(|extension| extension.to_str()),
        Some("xcworkspace" | "xcodeproj")
    ) {
        return Ok(Vec::new());
    }
    let mut workspaces = Vec::new();
    let mut projects = Vec::new();
    for entry in std::fs::read_dir(folder).map_err(|_| OpenFolderError::DiscoveryFailed)? {
        let entry = entry.map_err(|_| OpenFolderError::DiscoveryFailed)?;
        // Do not follow symlinks out of the working folder or descend into bundles.
        if !entry
            .file_type()
            .map_err(|_| OpenFolderError::DiscoveryFailed)?
            .is_dir()
        {
            continue;
        }
        let path = entry.path();
        match path.extension().and_then(|extension| extension.to_str()) {
            Some("xcworkspace") => workspaces.push(path),
            Some("xcodeproj") => projects.push(path),
            _ => {}
        }
    }
    let mut documents = if workspaces.is_empty() {
        projects
    } else {
        workspaces
    };
    documents.sort();
    Ok(documents)
}

#[derive(Clone, Debug)]
struct Application {
    path: PathBuf,
    name: String,
}

#[derive(Debug)]
struct OpenChoice {
    id: String,
    name: String,
    application: PathBuf,
    document: PathBuf,
}

fn select_choice(choices: Vec<OpenChoice>, id: &str) -> Result<OpenChoice, OpenFolderError> {
    choices
        .into_iter()
        .find(|choice| choice.id == id)
        .ok_or(OpenFolderError::AppMissing)
}

fn discover_choices(
    folder: &Path,
    projects: &[PathBuf],
    mut applications_for: impl FnMut(&Path) -> Result<Vec<Application>, OpenFolderError>,
) -> Result<Vec<OpenChoice>, OpenFolderError> {
    let mut choices: Vec<OpenChoice> = Vec::new();
    for document in projects
        .iter()
        .map(PathBuf::as_path)
        .chain(std::iter::once(folder))
    {
        for application in applications_for(document)? {
            // Prefer a project's document over the containing folder for apps
            // registered to handle both. Keep distinct projects selectable.
            if choices.iter().any(|choice| {
                choice.application == application.path
                    && (document == folder || choice.document == document)
            }) {
                continue;
            }
            let name = if document != folder && projects.len() > 1 {
                format!(
                    "{} — {}",
                    application.name,
                    document.file_name().unwrap_or_default().to_string_lossy()
                )
            } else {
                application.name
            };
            // The ID identifies a native (application, document) association. It
            // grants no authority: opening re-discovers and validates it below.
            let id = serde_json::to_string(&(&application.path, document))
                .map_err(|_| OpenFolderError::DiscoveryFailed)?;
            choices.push(OpenChoice {
                id,
                name,
                application: application.path,
                document: document.to_owned(),
            });
        }
    }
    Ok(choices)
}

async fn documents_for_thread(
    threads: &Threads,
    id: Uuid,
) -> Result<(PathBuf, Vec<PathBuf>), OpenFolderError> {
    let folder = working_folder(threads, id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let projects = project_documents(&folder)?;
        Ok((folder, projects))
    })
    .await
    .map_err(|_| OpenFolderError::DiscoveryFailed)?
}

#[tauri::command]
pub(crate) async fn list_working_folder_apps(
    app: tauri::AppHandle,
    threads: State<'_, Threads>,
    thread_id: Uuid,
) -> Result<Vec<WorkingFolderApp>, OpenFolderError> {
    #[cfg(target_os = "macos")]
    {
        let (folder, projects) = documents_for_thread(&threads, thread_id).await?;
        let (send, receive) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let result = macos::choices(&folder, &projects).map(|choices| {
                choices
                    .into_iter()
                    .map(|choice| WorkingFolderApp {
                        icon: choice.application.to_str().and_then(macos::icon),
                        id: choice.id,
                        name: choice.name,
                    })
                    .collect()
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
        let (folder, projects) = documents_for_thread(&threads, thread_id).await?;
        let (send, receive) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let result = macos::choices(&folder, &projects)
                .and_then(|choices| select_choice(choices, &target));
            let _ = send.send(result);
        })
        .map_err(|_| OpenFolderError::DiscoveryFailed)?;
        let choice = receive
            .await
            .map_err(|_| OpenFolderError::DiscoveryFailed)??;
        tauri::async_runtime::spawn_blocking(move || {
            let application = choice
                .application
                .to_str()
                .ok_or(OpenFolderError::AppMissing)?;
            tauri_plugin_opener::open_path(choice.document, Some(application))
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

#[cfg(target_os = "macos")]
mod macos {
    use super::{discover_choices, Application, OpenChoice, OpenFolderError};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use objc2::{runtime::NSObjectProtocol, sel, AllocAnyThread};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext,
        NSWorkspace,
    };
    use objc2_foundation::{NSDictionary, NSFileManager, NSPoint, NSRect, NSSize, NSString, NSURL};
    use std::path::{Path, PathBuf};

    pub(super) fn choices(
        folder: &Path,
        projects: &[PathBuf],
    ) -> Result<Vec<OpenChoice>, OpenFolderError> {
        let workspace = NSWorkspace::sharedWorkspace();
        // The application-list API was introduced in macOS 12. Fail discovery
        // normally on older systems instead of sending an unknown selector.
        if !workspace.respondsToSelector(sel!(URLsForApplicationsToOpenURL:)) {
            return Err(OpenFolderError::DiscoveryFailed);
        }
        discover_choices(folder, projects, |document| {
            let url = NSURL::from_file_path(document).ok_or(OpenFolderError::DiscoveryFailed)?;
            workspace
                .URLsForApplicationsToOpenURL(&url)
                .iter()
                .map(|url| {
                    let path = url.to_file_path().ok_or(OpenFolderError::DiscoveryFailed)?;
                    let native_path =
                        NSString::from_str(path.to_str().ok_or(OpenFolderError::DiscoveryFailed)?);
                    let name = NSFileManager::defaultManager()
                        .displayNameAtPath(&native_path)
                        .to_string();
                    Ok(Application {
                        path,
                        name: name.strip_suffix(".app").unwrap_or(&name).to_owned(),
                    })
                })
                .collect()
        })
    }

    pub(super) fn icon(path: &str) -> Option<String> {
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

    fn application() -> Application {
        Application {
            path: "/Applications/Unlisted Editor.app".into(),
            name: "Unlisted Editor".into(),
        }
    }

    #[test]
    fn discovers_apps_without_a_supported_application_registry() {
        let folder = Path::new("/tmp/project");
        let choices = discover_choices(folder, &[], |_| Ok(vec![application()])).unwrap();
        assert_eq!(choices[0].name, "Unlisted Editor");
        assert_eq!(choices[0].document, folder);
        assert_eq!(
            select_choice(choices, "/Applications/Calculator.app")
                .unwrap_err()
                .to_string(),
            OpenFolderError::AppMissing.to_string()
        );
    }

    #[test]
    fn opens_the_project_document_for_an_app_that_also_handles_folders() {
        let folder = Path::new("/tmp/project");
        let project = folder.join("Project.xcworkspace");
        let choices = discover_choices(folder, std::slice::from_ref(&project), |_| {
            Ok(vec![application()])
        })
        .unwrap();
        assert_eq!(choices.len(), 1);
        let id = choices[0].id.clone();
        assert_eq!(select_choice(choices, &id).unwrap().document, project);
    }

    #[test]
    fn distinguishes_multiple_documents_for_the_same_application() {
        let folder = Path::new("/tmp/project");
        let projects = [
            folder.join("First.xcworkspace"),
            folder.join("Second.xcworkspace"),
        ];
        let choices = discover_choices(folder, &projects, |_| Ok(vec![application()])).unwrap();
        assert_eq!(
            choices
                .iter()
                .map(|choice| choice.name.as_str())
                .collect::<Vec<_>>(),
            [
                "Unlisted Editor — First.xcworkspace",
                "Unlisted Editor — Second.xcworkspace"
            ]
        );
        assert_ne!(choices[0].id, choices[1].id);
    }

    #[test]
    fn keeps_folder_only_apps_alongside_project_apps_in_os_order() {
        let folder = Path::new("/tmp/project");
        let projects = [folder.join("Project.xcodeproj")];
        let choices = discover_choices(folder, &projects, |document| {
            if document == folder {
                Ok(vec![Application {
                    path: "/System/Library/CoreServices/Finder.app".into(),
                    name: "Finder".into(),
                }])
            } else {
                Ok(vec![application()])
            }
        })
        .unwrap();
        assert_eq!(
            choices
                .iter()
                .map(|choice| choice.name.as_str())
                .collect::<Vec<_>>(),
            ["Unlisted Editor", "Finder"]
        );
        assert_eq!(choices[1].document, folder);
    }

    #[test]
    fn handles_no_registered_apps_without_inventing_a_fallback() {
        assert!(
            discover_choices(Path::new("/tmp/project"), &[], |_| Ok(vec![]))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn prefers_root_workspaces_and_ignores_nested_projects() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("App.xcodeproj")).unwrap();
        std::fs::create_dir_all(root.path().join("nested/Other.xcworkspace")).unwrap();
        let workspace = root.path().join("App.xcworkspace");
        std::fs::create_dir(&workspace).unwrap();
        assert_eq!(project_documents(root.path()).unwrap(), [workspace]);
    }

    #[test]
    fn discovers_xcode_projects_when_no_workspace_exists() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("한글 project.xcodeproj");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir_all(project.join("project.xcworkspace")).unwrap();
        assert_eq!(
            project_documents(root.path()).unwrap(),
            std::slice::from_ref(&project)
        );
        assert!(project_documents(&project).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_project_symlinks_out_of_the_working_folder() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("Linked.xcworkspace")).unwrap();
        assert!(project_documents(root.path()).unwrap().is_empty());
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
