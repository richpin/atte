//! In-memory conversations, independent of the desktop and agent transport.
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

/// A local snapshot. Creation does not establish an agent session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    /// App-owned identifier, independent of any remote session.
    pub id: Uuid,
    /// Absolute working directory.
    pub working_folder: PathBuf,
    /// Fixed execution target for this conversation.
    pub agent_id: String,
    /// Connection state owned by the application.
    pub status: ConversationStatus,
}

/// Current agent connection state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConversationStatus {
    /// A local draft with no remote session.
    Disconnected,
}

/// Failures exposed to application callers and the UI.
#[derive(Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum ConversationError {
    /// The working folder is not an existing local directory.
    #[error("{0}")]
    InvalidWorkingFolder(String),
    /// The requested app conversation does not exist.
    #[error("{0}")]
    NotFound(String),
    /// Application state could not be accessed.
    #[error("{0}")]
    Unavailable(String),
}

/// Owns local conversation drafts for the lifetime of the application.
#[derive(Default)]
pub struct Conversations {
    drafts: Mutex<HashMap<Uuid, Conversation>>,
}

impl Conversations {
    /// Creates a disconnected draft assigned to the prepared Codex target.
    ///
    /// # Errors
    /// Returns an error if the folder is invalid or application state is unavailable.
    pub fn create(&self, folder: &Path) -> Result<Conversation, ConversationError> {
        if !folder.is_dir() {
            return Err(ConversationError::InvalidWorkingFolder(
                "존재하는 작업 폴더를 선택해주세요.".into(),
            ));
        }
        let draft = Conversation {
            id: Uuid::new_v4(),
            working_folder: folder.canonicalize().map_err(|_| {
                ConversationError::InvalidWorkingFolder("작업 폴더를 찾을 수 없습니다.".into())
            })?,
            agent_id: "codex".into(),
            status: ConversationStatus::Disconnected,
        };
        self.drafts
            .lock()
            .map_err(|_| ConversationError::Unavailable("대화 상태를 읽을 수 없습니다.".into()))?
            .insert(draft.id, draft.clone());
        Ok(draft)
    }

    /// Retrieves the current snapshot by its app-owned ID.
    ///
    /// # Errors
    /// Returns an error for an unknown ID or unavailable application state.
    pub fn get(&self, id: Uuid) -> Result<Conversation, ConversationError> {
        self.drafts
            .lock()
            .map_err(|_| ConversationError::Unavailable("대화 상태를 읽을 수 없습니다.".into()))?
            .get(&id)
            .cloned()
            .ok_or_else(|| ConversationError::NotFound("대화를 찾을 수 없습니다.".into()))
    }
}
