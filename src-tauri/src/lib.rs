//! Atte desktop application.
pub mod agent;
mod agent_runtime;
pub mod conversation;

use conversation::{Conversation, ConversationError, Conversations};
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
fn send_message(
    id: Uuid,
    text: String,
    conversations: State<'_, Conversations>,
) -> Result<Conversation, ConversationError> {
    conversations.send_message(id, text)?;
    conversations.get(id)
}

#[tauri::command]
async fn subscribe_conversation(
    id: Uuid,
    channel: tauri::ipc::Channel<Conversation>,
    window: tauri::WebviewWindow,
    conversations: State<'_, Conversations>,
    subscriptions: State<'_, Subscriptions>,
) -> Result<Uuid, ConversationError> {
    let mut receiver = conversations.subscribe(id)?;
    let subscription = Uuid::new_v4();
    let (stop, mut stopped) = oneshot::channel();
    let subscriptions = subscriptions.inner().clone();
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
                snapshot = receiver.recv() => match snapshot {
                    Some(snapshot) => if channel.send(snapshot).is_err() { break; },
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
        .manage(Conversations::default())
        .manage(Subscriptions::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut entries) = window.state::<Subscriptions>().0.lock() {
                    entries.retain(|_, entry| entry.window != window.label());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            select_working_folder,
            get_conversation,
            prepared_agents,
            connect_conversation,
            send_message,
            subscribe_conversation,
            unsubscribe_conversation
        ])
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|handle, event| {
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(handle.state::<Conversations>().shutdown());
            }
        }),
        Err(error) => {
            eprintln!("error while running Atte: {error}");
            std::process::exit(1);
        }
    }
}
