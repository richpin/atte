//! Atte desktop application.
pub mod agent;
pub mod agent_management;
mod agent_runtime;
pub mod conversation;
mod installation_files;
mod lifecycle;
pub mod storage;

use conversation::{
    Conversation, ConversationError, ConversationMetadata, ConversationUpdate, Conversations,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
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
) -> Result<Option<Conversation>, ConversationError> {
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
            ConversationError::InvalidWorkingFolder("로컬 작업 폴더를 선택해주세요.".into())
        })?;
        app.state::<Conversations>()
            .create_for_agent(&path, &agent_id)
            .map(Some)
    })
    .await
    .map_err(|_| {
        ConversationError::Unavailable("폴더 선택을 완료할 수 없습니다. 다시 시도해주세요.".into())
    })?
}

#[tauri::command]
async fn create_conversation(
    folder: String,
    agent_id: String,
    conversations: State<'_, Conversations>,
) -> Result<Conversation, ConversationError> {
    conversations.create_for_agent(std::path::Path::new(&folder), &agent_id)
}

#[tauri::command]
fn list_conversations(
    conversations: State<'_, Conversations>,
) -> Result<Vec<ConversationMetadata>, ConversationError> {
    conversations.list()
}

#[tauri::command]
fn get_conversation(
    id: Uuid,
    conversations: State<'_, Conversations>,
) -> Result<Conversation, ConversationError> {
    conversations.get(id)
}

#[tauri::command]
fn prepared_agents(conversations: State<'_, Conversations>) -> Vec<agent::PreparedAgent> {
    conversations.prepared_agents()
}

#[tauri::command]
async fn connect_conversation(
    id: Uuid,
    conversations: State<'_, Conversations>,
) -> Result<Conversation, ConversationError> {
    conversations.connect(id)
}

#[tauri::command]
async fn send_message(
    id: Uuid,
    text: String,
    conversations: State<'_, Conversations>,
) -> Result<Conversation, ConversationError> {
    conversations.send_message(id, text)?;
    conversations.get(id)
}

#[tauri::command]
async fn delete_queued_message(
    id: Uuid,
    message: Uuid,
    conversations: State<'_, Conversations>,
) -> Result<Conversation, ConversationError> {
    conversations.delete_queued_message(id, message)?;
    conversations.get(id)
}

#[tauri::command]
async fn cancel_turn(
    id: Uuid,
    turn: Uuid,
    conversations: State<'_, Conversations>,
) -> Result<Conversation, ConversationError> {
    conversations.cancel_turn(id, turn)?;
    conversations.get(id)
}

#[tauri::command]
async fn answer_permission(
    id: Uuid,
    request: Uuid,
    option: String,
    conversations: State<'_, Conversations>,
) -> Result<Conversation, ConversationError> {
    conversations.answer_permission(id, request, option)?;
    conversations.get(id)
}

#[tauri::command]
async fn subscribe_conversation(
    id: Uuid,
    channel: tauri::ipc::Channel<ConversationUpdate>,
    window: tauri::WebviewWindow,
    conversations: State<'_, Conversations>,
    subscriptions: State<'_, Subscriptions>,
) -> Result<Uuid, ConversationError> {
    forward_subscription(
        conversations.subscribe(id)?,
        channel,
        window,
        subscriptions.inner().clone(),
    )
}

#[tauri::command]
async fn subscribe_conversation_list(
    channel: tauri::ipc::Channel<Vec<ConversationMetadata>>,
    window: tauri::WebviewWindow,
    conversations: State<'_, Conversations>,
    subscriptions: State<'_, Subscriptions>,
) -> Result<Uuid, ConversationError> {
    forward_subscription(
        conversations.subscribe_list()?,
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
) -> Result<Uuid, ConversationError> {
    let subscription = Uuid::new_v4();
    let (stop, mut stopped) = oneshot::channel();
    subscriptions
        .0
        .lock()
        .map_err(|_| ConversationError::Unavailable("구독할 수 없습니다.".into()))?
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
fn unsubscribe_conversation(
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

/// Runs the desktop application and its managed conversation state.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let management = agent_management::AgentManagement::open(&app.path().app_data_dir()?)?;
            let conversations = management.restore_conversations()?;
            app.manage(conversations);
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
            get_conversation,
            list_conversations,
            create_conversation,
            delete_queued_message,
            subscribe_conversation_list,
            prepared_agents,
            connect_conversation,
            send_message,
            cancel_turn,
            answer_permission,
            subscribe_conversation,
            unsubscribe_conversation
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
    conversations: State<'_, Conversations>,
    management: State<'_, agent_management::AgentManagement>,
) -> Result<Vec<agent_management::ManagedAgent>, String> {
    management
        .catalog(&conversations)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn refresh_agent_catalog(
    conversations: State<'_, Conversations>,
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
                .catalog(&conversations)
                .map_err(|error| error.to_string())
        })
        .await
}

#[tauri::command]
async fn install_agent(
    id: String,
    channel: tauri::ipc::Channel<String>,
    management: State<'_, agent_management::AgentManagement>,
    conversations: State<'_, Conversations>,
    lifecycle: State<'_, lifecycle::Lifecycle>,
) -> Result<(), String> {
    lifecycle
        .finish_before_exit(async {
            management
                .install(
                    &id,
                    &conversations,
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
    conversations: State<'_, Conversations>,
    lifecycle: State<'_, lifecycle::Lifecycle>,
) -> Result<(), String> {
    lifecycle
        .finish_before_exit(async {
            management
                .uninstall(&id, &conversations)
                .await
                .map_err(|error| error.to_string())
        })
        .await
}

#[tauri::command]
async fn authenticate_agent(
    conversations: State<'_, Conversations>,
    id: String,
    method: Option<String>,
    management: State<'_, agent_management::AgentManagement>,
    lifecycle: State<'_, lifecycle::Lifecycle>,
) -> Result<agent_management::authentication::Authentication, String> {
    lifecycle
        .operation(async {
            management
                .authenticate(&id, method.as_deref(), &conversations)
                .await
                .map_err(|error| error.to_string())
        })
        .await
}
