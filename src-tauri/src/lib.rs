//! Atte desktop application.
pub mod agent;
mod agent_runtime;
pub mod conversation;

use conversation::{Conversation, ConversationError, Conversations};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

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

/// Runs the desktop application and its managed conversation state.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Conversations::default())
        .invoke_handler(tauri::generate_handler![
            select_working_folder,
            get_conversation,
            prepared_agents,
            connect_conversation
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
