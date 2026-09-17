//! In-memory conversations, independent of the desktop and agent transport.
use crate::agent::{prepared_codex, AgentDefinition, PreparedAgent};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot};
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
    /// Agent-issued ID, scoped by this conversation's fixed agent and runtime.
    pub remote_session_id: Option<String>,
    /// Connection success is not proof of authentication.
    pub authentication: AuthenticationStatus,
    pub failure: Option<ConnectionFailure>,
    pub revision: u64,
    pub turns: Vec<Turn>,
    pub notice: Option<String>,
}

/// Current agent connection state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConversationStatus {
    /// A local draft with no remote session.
    Disconnected,
    Connecting,
    SessionReady,
    Running,
    Failed,
}

/// Authentication evidence available at this stage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthenticationStatus {
    Unknown,
    Required,
}

/// Actionable connection failures without exposing agent payloads or credentials.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionFailure {
    ExecutableNotFound,
    LaunchFailed,
    InitializationFailed,
    SessionCreationFailed,
    AuthenticationRequired,
    ProcessExited,
    ConnectionClosed,
    TimedOut,
    PromptFailed,
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
    #[error("{0}")]
    NotReady(String),
    #[error("{0}")]
    InvalidMessage(String),
    /// Application state could not be accessed.
    #[error("{0}")]
    Unavailable(String),
}

/// Owns conversation state and agent runtime lifetimes.
pub struct Conversations {
    agents: Vec<AgentDefinition>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    entries: HashMap<Uuid, Entry>,
    closed: bool,
}

struct Entry {
    state: Arc<Mutex<ConversationState>>,
    runtime: Option<Runtime>,
}

struct Runtime {
    prompts: mpsc::UnboundedSender<Prompt>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

impl Default for Conversations {
    fn default() -> Self {
        Self::new(vec![prepared_codex()])
    }
}

impl Conversations {
    /// Uses trusted launch definitions supplied by the outer application adapter.
    pub fn new(agents: Vec<AgentDefinition>) -> Self {
        Self {
            agents,
            state: Mutex::new(State::default()),
        }
    }

    pub fn prepared_agents(&self) -> Vec<PreparedAgent> {
        self.agents
            .iter()
            .map(|agent| PreparedAgent {
                id: agent.id.clone(),
                name: agent.name.clone(),
            })
            .collect()
    }

    /// Creates a disconnected draft assigned to the first prepared target.
    ///
    /// # Errors
    /// Returns an error if the folder is invalid or application state is unavailable.
    pub fn create(&self, folder: &Path) -> Result<Conversation, ConversationError> {
        let agent = self.agents.first().ok_or_else(not_found)?;
        self.create_for_agent(folder, &agent.id)
    }

    /// Creates a draft with a fixed prepared agent and validated working folder.
    pub fn create_for_agent(
        &self,
        folder: &Path,
        agent_id: &str,
    ) -> Result<Conversation, ConversationError> {
        if !self.agents.iter().any(|agent| agent.id == agent_id) {
            return Err(ConversationError::NotFound(
                "준비된 에이전트를 찾을 수 없습니다.".into(),
            ));
        }
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
            agent_id: agent_id.into(),
            status: ConversationStatus::Disconnected,
            remote_session_id: None,
            authentication: AuthenticationStatus::Unknown,
            failure: None,
            revision: 0,
            turns: Vec::new(),
            notice: None,
        };
        let mut state = self.lock()?;
        if state.closed {
            return Err(unavailable());
        }
        state.entries.insert(
            draft.id,
            Entry {
                state: Arc::new(Mutex::new(ConversationState {
                    snapshot: draft.clone(),
                    generation: 0,
                    subscribers: Vec::new(),
                })),
                runtime: None,
            },
        );
        Ok(draft)
    }

    /// Retrieves the current snapshot by its app-owned ID.
    ///
    /// # Errors
    /// Returns an error for an unknown ID or unavailable application state.
    pub fn get(&self, id: Uuid) -> Result<Conversation, ConversationError> {
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let snapshot = entry
            .state
            .lock()
            .map_err(|_| unavailable())?
            .snapshot
            .clone();
        Ok(snapshot)
    }

    /// Starts one connection attempt. Concurrent requests return the same state.
    /// Requires a Tokio runtime; failures are observed through `get`.
    pub fn connect(&self, id: Uuid) -> Result<Conversation, ConversationError> {
        let mut state = self.lock()?;
        if state.closed {
            return Err(unavailable());
        }
        let entry = state.entries.get_mut(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        let mut snapshot = current.snapshot.clone();
        if matches!(
            snapshot.status,
            ConversationStatus::Connecting
                | ConversationStatus::SessionReady
                | ConversationStatus::Running
        ) {
            return Ok(snapshot);
        }
        if !snapshot.working_folder.is_dir() {
            return Err(ConversationError::InvalidWorkingFolder(
                "작업 폴더를 찾을 수 없습니다. 폴더를 다시 선택해주세요.".into(),
            ));
        }
        let agent = self
            .agents
            .iter()
            .find(|agent| agent.id == snapshot.agent_id)
            .ok_or_else(not_found)?
            .clone();
        let handle = tokio::runtime::Handle::try_current().map_err(|_| unavailable())?;
        snapshot.status = ConversationStatus::Connecting;
        snapshot.remote_session_id = None;
        snapshot.authentication = AuthenticationStatus::Unknown;
        snapshot.failure = None;
        current.generation += 1;
        current.snapshot = snapshot;
        current.publish();
        let snapshot = current.snapshot.clone();
        let (stop, receiver) = oneshot::channel();
        let updates = RuntimeUpdates {
            state: entry.state.clone(),
            generation: current.generation,
        };
        let (prompts, requests) = mpsc::unbounded_channel();
        let folder = snapshot.working_folder.clone();
        entry.runtime = Some(Runtime {
            prompts,
            stop: Some(stop),
            task: Some(handle.spawn(crate::agent_runtime::run(
                agent, folder, updates, receiver, requests,
            ))),
        });
        Ok(snapshot)
    }

    /// Atomically subscribes to a snapshot and every subsequent revision.
    /// Dropping the receiver does not stop the conversation.
    pub fn subscribe(
        &self,
        id: Uuid,
    ) -> Result<mpsc::UnboundedReceiver<Conversation>, ConversationError> {
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        let (sender, receiver) = mpsc::unbounded_channel();
        let _ = sender.send(current.snapshot.clone());
        current
            .subscribers
            .retain(|subscriber| !subscriber.is_closed());
        current.subscribers.push(sender);
        Ok(receiver)
    }

    /// Admits exactly one prompt while ready, before publishing it to the runtime.
    pub fn send_message(&self, id: Uuid, text: String) -> Result<(), ConversationError> {
        if text.trim().is_empty() {
            return Err(ConversationError::InvalidMessage(
                "메시지를 입력해주세요.".into(),
            ));
        }
        let state = self.lock()?;
        if state.closed {
            return Err(unavailable());
        }
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        if current.snapshot.status != ConversationStatus::SessionReady {
            return Err(ConversationError::NotReady(
                "응답이 완료된 연결된 대화에서 전송해주세요.".into(),
            ));
        }
        let runtime = entry.runtime.as_ref().ok_or_else(unavailable)?;
        let turn = Uuid::new_v4();
        runtime
            .prompts
            .send(Prompt {
                turn,
                text: text.clone(),
            })
            .map_err(|_| unavailable())?;
        current.snapshot.status = ConversationStatus::Running;
        current.snapshot.failure = None;
        current.snapshot.notice = None;
        current.snapshot.turns.push(Turn {
            id: turn,
            message: text,
            response: String::new(),
            stop_reason: None,
        });
        current.publish();
        Ok(())
    }

    /// Stops and reaps all owned processes before application exit.
    pub async fn shutdown(&self) {
        let runtimes = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            state.closed = true;
            state
                .entries
                .values_mut()
                .filter_map(|entry| entry.runtime.take())
                .collect::<Vec<_>>()
        };
        // Signal every connection before awaiting any one of them.
        let mut tasks = Vec::new();
        for mut runtime in runtimes {
            if let Some(stop) = runtime.stop.take() {
                let _ = stop.send(());
            }
            if let Some(task) = runtime.task.take() {
                tasks.push(task);
            }
        }
        for task in tasks {
            let _ = task.await;
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, ConversationError> {
        self.state.lock().map_err(|_| unavailable())
    }
}

fn unavailable() -> ConversationError {
    ConversationError::Unavailable("대화 상태를 사용할 수 없습니다.".into())
}

fn not_found() -> ConversationError {
    ConversationError::NotFound("대화를 찾을 수 없습니다.".into())
}

/// One accepted user message and its streamed response.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: Uuid,
    pub message: String,
    pub response: String,
    pub stop_reason: Option<String>,
}

pub(crate) struct Prompt {
    pub turn: Uuid,
    pub text: String,
}

struct ConversationState {
    snapshot: Conversation,
    generation: u64,
    subscribers: Vec<mpsc::UnboundedSender<Conversation>>,
}

impl ConversationState {
    fn publish(&mut self) {
        self.snapshot.revision += 1;
        self.subscribers
            .retain(|sender| sender.send(self.snapshot.clone()).is_ok());
    }
}

/// A connection-scoped writer. Retired runtimes cannot overwrite a replacement.
#[derive(Clone)]
pub(crate) struct RuntimeUpdates {
    state: Arc<Mutex<ConversationState>>,
    generation: u64,
}

impl RuntimeUpdates {
    pub fn modify(&self, turn: Option<Uuid>, update: impl FnOnce(&mut Conversation)) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.generation != self.generation {
            return;
        }
        if let Some(turn) = turn {
            if state.snapshot.status != ConversationStatus::Running
                || state.snapshot.turns.last().map(|item| item.id) != Some(turn)
            {
                return;
            }
        }
        update(&mut state.snapshot);
        state.publish();
    }
}
