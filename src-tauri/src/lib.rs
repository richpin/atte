//! Atte desktop application.
pub mod agent;
pub mod agent_management;
mod agent_runtime;
mod browser;
mod file_selection;
mod installation;
mod installation_files;
mod lifecycle;
mod open_working_folder;
pub mod storage;
pub mod thread;
mod workspace_files;

use file_selection::{
    prepare_file_selection, prepare_media_selection, FileSelection, FileSelectionError,
    SelectedFiles, SubmittedInput,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use thread::{
    Attachment, AttachmentKind, MediaKind, ThreadError, ThreadMetadata, ThreadUpdate, Threads,
};
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(Default, Clone)]
struct Subscriptions(Arc<Mutex<HashMap<Uuid, Subscription>>>);

struct Subscription {
    window: String,
    _stop: oneshot::Sender<()>,
}

#[tauri::command]
async fn select_working_folder(
    app: tauri::AppHandle,
    dialog_title: String,
) -> Result<Option<std::path::PathBuf>, ThreadError> {
    tauri::async_runtime::spawn_blocking(move || {
        let selection = app
            .dialog()
            .file()
            .set_title(dialog_title)
            .blocking_pick_folder();
        let Some(selection) = selection else {
            return Ok(None);
        };
        let path = selection.into_path().map_err(|_| {
            ThreadError::InvalidWorkingFolder("로컬 작업 폴더를 선택해주세요.".into())
        })?;
        Ok(Some(path))
    })
    .await
    .map_err(|_| {
        ThreadError::Unavailable("폴더 선택을 완료할 수 없습니다. 다시 시도해주세요.".into())
    })?
}

#[tauri::command]
async fn select_files(
    app: tauri::AppHandle,
    id: Uuid,
    dialog_title: String,
    window: tauri::Webview,
) -> Result<FileSelection, ThreadError> {
    tauri::async_runtime::spawn_blocking(move || {
        let selections = app
            .dialog()
            .file()
            .set_title(dialog_title)
            .blocking_pick_files()
            .unwrap_or_default();
        let mut paths = Vec::with_capacity(selections.len());
        let mut invalid = Vec::new();
        for selection in selections {
            match selection.into_path() {
                Ok(path) => paths.push(path),
                Err(_) => invalid.push(FileSelectionError {
                    name: "선택한 파일".into(),
                }),
            }
        }
        let mut result = prepare_file_selection(paths);
        result.errors.extend(invalid);
        app.state::<SelectedFiles>()
            .remember(window.label(), id, &result)?;
        Ok(result)
    })
    .await
    .map_err(|_| {
        ThreadError::Unavailable("파일 선택을 완료할 수 없습니다. 다시 시도해주세요.".into())
    })?
}

#[tauri::command]
async fn select_media(
    app: tauri::AppHandle,
    id: Uuid,
    kind: MediaKind,
    dialog_title: String,
    window: tauri::Webview,
) -> Result<FileSelection, ThreadError> {
    if !app
        .state::<Threads>()
        .supports_attachment(id, kind.into())?
    {
        return Err(ThreadError::InvalidMessage(
            "에이전트가 이 미디어 첨부를 지원하지 않습니다.".into(),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let extensions: &[&str] = match kind {
            MediaKind::Image => &[
                "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg", "heic", "heif",
                "avif",
            ],
            MediaKind::Audio => &[
                "mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus", "aiff", "aif",
            ],
        };
        let selections = app
            .dialog()
            .file()
            .set_title(dialog_title)
            .add_filter(
                if kind == MediaKind::Image {
                    "Images"
                } else {
                    "Audio"
                },
                extensions,
            )
            .blocking_pick_files()
            .unwrap_or_default();
        let mut paths = Vec::with_capacity(selections.len());
        let mut invalid = Vec::new();
        for selection in selections {
            match selection.into_path() {
                Ok(path) => paths.push(path),
                Err(_) => invalid.push(FileSelectionError {
                    name: "선택한 파일".into(),
                }),
            }
        }
        let store = app
            .state::<Threads>()
            .media_store()
            .ok_or_else(|| ThreadError::Unavailable("첨부 저장소를 사용할 수 없습니다.".into()))?;
        let mut result = prepare_media_selection(paths, id, kind, &store);
        result.errors.extend(invalid);
        app.state::<SelectedFiles>()
            .remember(window.label(), id, &result)?;
        Ok(result)
    })
    .await
    .map_err(|_| ThreadError::Unavailable("미디어 선택을 완료할 수 없습니다.".into()))?
}

#[tauri::command]
async fn snapshot_clipboard_image(
    id: Uuid,
    name: String,
    mime_type: String,
    bytes: Vec<u8>,
    window: tauri::Webview,
    threads: State<'_, Threads>,
    selected_files: State<'_, SelectedFiles>,
) -> Result<FileSelection, ThreadError> {
    if !threads.supports_attachment(id, AttachmentKind::Image)? {
        return Err(ThreadError::InvalidMessage(
            "에이전트가 이미지 첨부를 지원하지 않습니다.".into(),
        ));
    }
    let store = threads
        .media_store()
        .ok_or_else(|| ThreadError::Unavailable("첨부 저장소를 사용할 수 없습니다.".into()))?;
    let attachment = store.snapshot(id, name, MediaKind::Image, &bytes, Some(&mime_type))?;
    let result = FileSelection {
        attachments: vec![attachment],
        errors: Vec::new(),
    };
    selected_files.remember(window.label(), id, &result)?;
    Ok(result)
}

#[tauri::command]
async fn create_thread(
    folder: String,
    agent_id: String,
    threads: State<'_, Threads>,
) -> Result<Uuid, ThreadError> {
    threads
        .create_for_agent(std::path::Path::new(&folder), &agent_id)
        .map(|thread| thread.id)
}

#[tauri::command]
fn list_threads(threads: State<'_, Threads>) -> Result<Vec<ThreadMetadata>, ThreadError> {
    threads.list()
}

#[tauri::command]
fn delete_thread(
    id: Uuid,
    threads: State<'_, Threads>,
    files: State<'_, workspace_files::WorkspaceFiles>,
) -> Result<(), ThreadError> {
    threads.delete(id)?;
    files.forget(id);
    Ok(())
}

#[tauri::command]
fn prepared_agents(threads: State<'_, Threads>) -> Vec<agent::PreparedAgent> {
    threads.prepared_agents()
}

#[tauri::command]
async fn connect_thread(id: Uuid, threads: State<'_, Threads>) -> Result<(), ThreadError> {
    threads.connect(id).map(|_| ())
}

#[tauri::command]
async fn reconnect_thread(id: Uuid, threads: State<'_, Threads>) -> Result<(), ThreadError> {
    threads.reconnect(id).map(|_| ())
}

#[tauri::command]
async fn send_message(
    id: Uuid,
    input: SubmittedInput,
    window: tauri::Webview,
    threads: State<'_, Threads>,
    selected_files: State<'_, SelectedFiles>,
) -> Result<(), ThreadError> {
    let resolved = selected_files.resolve(window.label(), id, &input)?;
    threads.send_input(id, resolved)?;
    let _ = selected_files.forget(window.label(), &input.attachments);
    Ok(())
}

#[tauri::command]
fn release_files(
    attachments: Vec<Uuid>,
    window: tauri::Webview,
    selected_files: State<'_, SelectedFiles>,
) {
    let forgotten = selected_files.forget(window.label(), &attachments);
    remove_forgotten_media(&window.state::<Threads>(), forgotten);
}

fn remove_forgotten_media(threads: &Threads, forgotten: Vec<(Uuid, Attachment)>) {
    let Some(store) = threads.media_store() else {
        return;
    };
    for (thread, attachment) in forgotten {
        if attachment.kind != AttachmentKind::File {
            store.remove(thread, [attachment.id]);
        }
    }
}

#[tauri::command]
async fn delete_queued_message(
    id: Uuid,
    message: Uuid,
    threads: State<'_, Threads>,
) -> Result<(), ThreadError> {
    threads.delete_queued_message(id, message)
}

#[tauri::command]
async fn retry_queued_message(
    id: Uuid,
    message: Uuid,
    threads: State<'_, Threads>,
) -> Result<(), ThreadError> {
    threads.retry_queued_message(id, message)
}

#[tauri::command]
async fn cancel_turn(id: Uuid, turn: Uuid, threads: State<'_, Threads>) -> Result<(), ThreadError> {
    threads.cancel_turn(id, turn)
}

#[tauri::command]
async fn answer_permission(
    id: Uuid,
    request: Uuid,
    option: String,
    threads: State<'_, Threads>,
) -> Result<(), ThreadError> {
    threads.answer_permission(id, request, option)
}

#[tauri::command]
async fn set_thread_configuration(
    id: Uuid,
    config_id: String,
    value: thread::ThreadConfigurationValue,
    threads: State<'_, Threads>,
) -> Result<(), ThreadError> {
    threads.set_configuration(id, config_id, value).await
}

#[tauri::command]
async fn subscribe_thread(
    id: Uuid,
    channel: tauri::ipc::Channel<ThreadUpdate>,
    window: tauri::Webview,
    threads: State<'_, Threads>,
    subscriptions: State<'_, Subscriptions>,
) -> Result<Uuid, ThreadError> {
    forward_subscription(
        threads.subscribe(id)?,
        channel,
        window,
        subscriptions.inner().clone(),
    )
}

#[tauri::command]
async fn subscribe_thread_list(
    channel: tauri::ipc::Channel<Vec<ThreadMetadata>>,
    window: tauri::Webview,
    threads: State<'_, Threads>,
    subscriptions: State<'_, Subscriptions>,
) -> Result<Uuid, ThreadError> {
    forward_subscription(
        threads.subscribe_list()?,
        channel,
        window,
        subscriptions.inner().clone(),
    )
}

fn forward_subscription<T: serde::Serialize + Send + 'static>(
    mut receiver: tokio::sync::mpsc::UnboundedReceiver<T>,
    channel: tauri::ipc::Channel<T>,
    window: tauri::Webview,
    subscriptions: Subscriptions,
) -> Result<Uuid, ThreadError> {
    let subscription = Uuid::new_v4();
    let (stop, mut stopped) = oneshot::channel();
    subscriptions
        .0
        .lock()
        .map_err(|_| ThreadError::Unavailable("구독할 수 없습니다.".into()))?
        .insert(
            subscription,
            Subscription {
                window: window.label().to_owned(),
                _stop: stop,
            },
        );
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                update = receiver.recv() => match update {
                    Some(update) => if channel.send(update).is_err() { break; },
                    None => break,
                }
            }
        }
        if let Ok(mut subscriptions) = subscriptions.0.lock() {
            subscriptions.remove(&subscription);
        }
    });
    Ok(subscription)
}

#[tauri::command]
fn unsubscribe_thread(
    subscription: Uuid,
    window: tauri::Webview,
    subscriptions: State<'_, Subscriptions>,
) {
    if let Ok(mut entries) = subscriptions.0.lock() {
        if entries
            .get(&subscription)
            .is_some_and(|entry| entry.window == window.label())
        {
            entries.remove(&subscription);
        }
    }
}

/// Runs the desktop application and its managed thread state.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Remote web tabs handle new-window requests themselves. The opener's
        // automatic click interceptor would swallow their target="_blank" links.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            let management = agent_management::AgentManagement::open(&app.path().app_data_dir()?)?;
            let threads = management.restore_threads()?;
            app.manage(threads);
            app.manage(management);
            let updates = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let management = updates.state::<agent_management::AgentManagement>();
                    let threads = updates.state::<Threads>();
                    let installer = management.installer();
                    match management
                        .refresh_from(agent_management::registry::REGISTRY_URL, true)
                        .await
                    {
                        Ok(()) => {
                            let _ = management.prepare_updates(&threads, &installer).await;
                        }
                        Err(error) => eprintln!("background Registry refresh failed: {error}"),
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(60 * 60)).await;
                }
            });
            lifecycle::install(app.handle())?;
            Ok(())
        })
        .manage(Subscriptions::default())
        .manage(SelectedFiles::default())
        .manage(workspace_files::WorkspaceFiles::default())
        .manage(lifecycle::Lifecycle::default())
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<workspace_files::WorkspaceFiles>().clear();
                let forgotten = window.state::<SelectedFiles>().forget_owner(window.label());
                remove_forgotten_media(&window.state::<Threads>(), forgotten);
                if let Ok(mut entries) = window.state::<Subscriptions>().0.lock() {
                    entries.retain(|_, entry| entry.window != window.label());
                }
            }
        })
        .invoke_handler(|invoke| {
            if invoke.message.webview_ref().label() != "main" {
                invoke
                    .resolver
                    .reject("Application commands are restricted to the main webview");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
                workspace_files::subscribe_workspace_files,
                workspace_files::unsubscribe_workspace_files,
                workspace_files::read_workspace_file,
                workspace_files::save_workspace_file,
                workspace_files::operate_workspace_file,
                lifecycle::resolve_quit,
                lifecycle::set_files_dirty,
                browser::create_web_tab,
                browser::web_tab_action,
                browser::web_tab_state,
                agent_catalog,
                refresh_agent_catalog,
                install_agent,
                uninstall_agent,
                authenticate_agent,
                cancel_agent_authentication,
                logout_agent,
                select_working_folder,
                open_working_folder::list_working_folder_apps,
                open_working_folder::open_working_folder,
                open_working_folder::open_working_folder_with_app_picker,
                select_files,
                select_media,
                snapshot_clipboard_image,
                delete_thread,
                list_threads,
                create_thread,
                delete_queued_message,
                retry_queued_message,
                subscribe_thread_list,
                prepared_agents,
                connect_thread,
                reconnect_thread,
                send_message,
                release_files,
                cancel_turn,
                answer_permission,
                set_thread_configuration,
                subscribe_thread,
                unsubscribe_thread
            ];
            handler(invoke)
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(lifecycle::on_event),
        Err(error) => {
            eprintln!("error while running Atte: {error}");
            std::process::exit(1);
        }
    }
}

#[tauri::command]
async fn agent_catalog(
    threads: State<'_, Threads>,
    management: State<'_, agent_management::AgentManagement>,
) -> Result<Vec<agent_management::ManagedAgent>, String> {
    management
        .catalog(&threads)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn refresh_agent_catalog(
    threads: State<'_, Threads>,
    management: State<'_, agent_management::AgentManagement>,
    lifecycle: State<'_, lifecycle::Lifecycle>,
) -> Result<Vec<agent_management::ManagedAgent>, String> {
    lifecycle
        .operation(async {
            management
                .refresh_from(agent_management::registry::REGISTRY_URL, true)
                .await
                .map_err(|error| error.to_string())?;
            management
                .prepare_updates(&threads, &management.installer())
                .await
                .map_err(|error| error.to_string())?;
            management
                .catalog(&threads)
                .map_err(|error| error.to_string())
        })
        .await
}

#[tauri::command]
async fn install_agent(
    id: String,
    channel: tauri::ipc::Channel<String>,
    management: State<'_, agent_management::AgentManagement>,
    threads: State<'_, Threads>,
    lifecycle: State<'_, lifecycle::Lifecycle>,
) -> Result<(), String> {
    lifecycle
        .finish_before_exit(async {
            management
                .install(&id, &threads, &management.installer(), &|message| {
                    let _ = channel.send(message.to_owned());
                })
                .await
                .map_err(|error| error.to_string())
        })
        .await
}

#[tauri::command]
async fn uninstall_agent(
    id: String,
    management: State<'_, agent_management::AgentManagement>,
    threads: State<'_, Threads>,
    lifecycle: State<'_, lifecycle::Lifecycle>,
) -> Result<(), String> {
    lifecycle
        .finish_before_exit(async {
            management
                .uninstall(&id, &threads)
                .await
                .map_err(|error| error.to_string())
        })
        .await
}

#[tauri::command]
async fn authenticate_agent(
    threads: State<'_, Threads>,
    id: String,
    method: Option<String>,
    management: State<'_, agent_management::AgentManagement>,
    lifecycle: State<'_, lifecycle::Lifecycle>,
) -> Result<agent_management::authentication::Authentication, String> {
    lifecycle
        .operation(async {
            management
                .authenticate(&id, method.as_deref(), &threads)
                .await
                .map_err(|error| error.to_string())
        })
        .await
}

#[tauri::command]
async fn cancel_agent_authentication(
    id: String,
    management: State<'_, agent_management::AgentManagement>,
) -> Result<(), String> {
    management
        .cancel_authentication(&id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn logout_agent(
    threads: State<'_, Threads>,
    id: String,
    management: State<'_, agent_management::AgentManagement>,
    lifecycle: State<'_, lifecycle::Lifecycle>,
) -> Result<(), String> {
    lifecycle
        .operation(async {
            management
                .logout(&id, &threads)
                .await
                .map_err(|error| error.to_string())
        })
        .await
}
