//! Atte desktop application.
pub mod agent;
pub mod agent_management;
mod agent_runtime;
mod installation_files;
mod lifecycle;
pub mod storage;
pub mod thread;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use thread::{Thread, ThreadError, ThreadMetadata, ThreadUpdate, Threads};
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
    agent_id: String,
) -> Result<Option<Thread>, ThreadError> {
    tauri::async_runtime::spawn_blocking(move || {
        let selection = app
            .dialog()
            .file()
            .set_title("작업 폴더 선택")
            .blocking_pick_folder();
        let Some(selection) = selection else {
            return Ok(None);
        };
        let path = selection.into_path().map_err(|_| {
            ThreadError::InvalidWorkingFolder("로컬 작업 폴더를 선택해주세요.".into())
        })?;
        app.state::<Threads>()
            .create_for_agent(&path, &agent_id)
            .map(Some)
    })
    .await
    .map_err(|_| {
        ThreadError::Unavailable("폴더 선택을 완료할 수 없습니다. 다시 시도해주세요.".into())
    })?
}

#[tauri::command]
async fn create_thread(
    folder: String,
    agent_id: String,
    threads: State<'_, Threads>,
) -> Result<Thread, ThreadError> {
    threads.create_for_agent(std::path::Path::new(&folder), &agent_id)
}

#[tauri::command]
fn list_threads(threads: State<'_, Threads>) -> Result<Vec<ThreadMetadata>, ThreadError> {
    threads.list()
}

#[tauri::command]
fn get_thread(id: Uuid, threads: State<'_, Threads>) -> Result<Thread, ThreadError> {
    threads.get(id)
}

#[tauri::command]
fn prepared_agents(threads: State<'_, Threads>) -> Vec<agent::PreparedAgent> {
    threads.prepared_agents()
}

#[tauri::command]
async fn connect_thread(id: Uuid, threads: State<'_, Threads>) -> Result<Thread, ThreadError> {
    threads.connect(id)
}

#[tauri::command]
async fn send_message(
    id: Uuid,
    text: String,
    threads: State<'_, Threads>,
) -> Result<Thread, ThreadError> {
    threads.send_message(id, text)?;
    threads.get(id)
}

#[tauri::command]
async fn delete_queued_message(
    id: Uuid,
    message: Uuid,
    threads: State<'_, Threads>,
) -> Result<Thread, ThreadError> {
    threads.delete_queued_message(id, message)?;
    threads.get(id)
}

#[tauri::command]
async fn cancel_turn(
    id: Uuid,
    turn: Uuid,
    threads: State<'_, Threads>,
) -> Result<Thread, ThreadError> {
    threads.cancel_turn(id, turn)?;
    threads.get(id)
}

#[tauri::command]
async fn answer_permission(
    id: Uuid,
    request: Uuid,
    option: String,
    threads: State<'_, Threads>,
) -> Result<Thread, ThreadError> {
    threads.answer_permission(id, request, option)?;
    threads.get(id)
}

#[tauri::command]
async fn subscribe_thread(
    id: Uuid,
    channel: tauri::ipc::Channel<ThreadUpdate>,
    window: tauri::WebviewWindow,
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
    window: tauri::WebviewWindow,
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
    window: tauri::WebviewWindow,
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
    window: tauri::WebviewWindow,
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
        .setup(|app| {
            let management = agent_management::AgentManagement::open(&app.path().app_data_dir()?)?;
            let threads = management.restore_threads()?;
            app.manage(threads);
            app.manage(management);
            lifecycle::install(app.handle())?;
            Ok(())
        })
        .manage(Subscriptions::default())
        .manage(lifecycle::Lifecycle::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut entries) = window.state::<Subscriptions>().0.lock() {
                    entries.retain(|_, entry| entry.window != window.label());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            agent_catalog,
            refresh_agent_catalog,
            install_agent,
            uninstall_agent,
            authenticate_agent,
            select_working_folder,
            get_thread,
            list_threads,
            create_thread,
            delete_queued_message,
            subscribe_thread_list,
            prepared_agents,
            connect_thread,
            send_message,
            cancel_turn,
            answer_permission,
            subscribe_thread,
            unsubscribe_thread
        ])
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
    force: Option<bool>,
    lifecycle: State<'_, lifecycle::Lifecycle>,
) -> Result<Vec<agent_management::ManagedAgent>, String> {
    lifecycle
        .operation(async {
            if force.unwrap_or(true) {
                management.refresh().await
            } else {
                management.refresh_if_stale().await
            }
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
                .install(
                    &id,
                    &threads,
                    &agent_management::installer::SystemInstaller::default(),
                    &|message| {
                        let _ = channel.send(message.to_owned());
                    },
                )
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
