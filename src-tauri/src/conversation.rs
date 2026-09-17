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
    pub permissions: Vec<PermissionRequest>,
}

/// A pending decision with agent-supplied labels and opaque choice identifiers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: Uuid,
    pub title: String,
    pub details: String,
    pub options: Vec<PermissionOption>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PermissionOption {
    pub id: String,
    pub name: String,
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
    WaitingForApproval,
    Cancelling,
    Failed,
}

/// Authentication evidence available at this stage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthenticationStatus {
    Unknown,
    Required,
    Authenticated,
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
    AgentRemoved,
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
    agents: Mutex<Vec<AgentDefinition>>,
    lifecycle: tokio::sync::Mutex<()>,
    authentication: Arc<Mutex<HashMap<String, AuthenticationStatus>>>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    entries: HashMap<Uuid, Entry>,
    closed: bool,
}

struct Entry {
    agent: AgentDefinition,
    removed: bool,
    state: Arc<Mutex<ConversationState>>,
    runtime: Option<Runtime>,
}

struct Runtime {
    prompts: mpsc::UnboundedSender<Prompt>,
    cancellations: mpsc::UnboundedSender<Uuid>,
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
            agents: Mutex::new(agents),
            lifecycle: tokio::sync::Mutex::new(()),
            authentication: Arc::default(),
            state: Mutex::new(State::default()),
        }
    }

    pub fn prepared_agents(&self) -> Vec<PreparedAgent> {
        self.agents
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|agent| PreparedAgent {
                id: agent.id.clone(),
                name: agent.name.clone(),
            })
            .collect()
    }

    /// Latest authentication evidence from setup or an actual conversation request.
    pub fn authentication_status(&self, agent_id: &str) -> Option<AuthenticationStatus> {
        self.authentication.lock().ok()?.get(agent_id).cloned()
    }

    pub(crate) fn record_authentication(&self, agent_id: &str, status: AuthenticationStatus) {
        if let Ok(mut authentication) = self.authentication.lock() {
            authentication.insert(agent_id.into(), status);
        }
    }

    /// Publishes an installed execution definition without replacing conversation state.
    pub fn register_agent(&self, agent: AgentDefinition) -> Result<(), ConversationError> {
        let mut agents = self.agents.lock().map_err(|_| unavailable())?;
        if let Some(existing) = agents.iter_mut().find(|entry| entry.id == agent.id) {
            *existing = agent;
        } else {
            agents.push(agent);
        }
        Ok(())
    }

    /// Retires this agent's conversations and reaps their processes before file removal.
    pub async fn unregister_agent(&self, id: &str) -> Result<(), ConversationError> {
        let _lifecycle = self.lifecycle.lock().await;
        let runtimes = {
            let mut agents = self.agents.lock().map_err(|_| unavailable())?;
            let mut state = self.lock()?;
            agents.retain(|agent| agent.id != id);
            let mut runtimes = Vec::new();
            for entry in state
                .entries
                .values_mut()
                .filter(|entry| entry.agent.id == id)
            {
                entry.removed = true;
                let mut current = entry.state.lock().map_err(|_| unavailable())?;
                current.generation += 1;
                current.snapshot.status = ConversationStatus::Failed;
                current.snapshot.failure = Some(ConnectionFailure::AgentRemoved);
                current.snapshot.remote_session_id = None;
                current.snapshot.authentication = AuthenticationStatus::Unknown;
                current.clear_permissions();
                if let Some(turn) = current
                    .snapshot
                    .turns
                    .last_mut()
                    .filter(|turn| turn.stop_reason.is_none())
                {
                    turn.stop_reason = Some("cancelled".into());
                }
                current.publish();
                if let Some(runtime) = entry.runtime.take() {
                    runtimes.push(runtime);
                }
            }
            runtimes
        };
        stop_runtimes(runtimes).await;
        Ok(())
    }

    /// Creates a disconnected draft assigned to the first prepared target.
    ///
    /// # Errors
    /// Returns an error if the folder is invalid or application state is unavailable.
    pub fn create(&self, folder: &Path) -> Result<Conversation, ConversationError> {
        let id = self
            .agents
            .lock()
            .map_err(|_| unavailable())?
            .first()
            .ok_or_else(not_found)?
            .id
            .clone();
        self.create_for_agent(folder, &id)
    }

    /// Creates a draft with a fixed prepared agent and validated working folder.
    pub fn create_for_agent(
        &self,
        folder: &Path,
        agent_id: &str,
    ) -> Result<Conversation, ConversationError> {
        // Keep this guard until insertion so unregister cannot miss a new owner.
        let agents = self.agents.lock().map_err(|_| unavailable())?;
        let agent = agents
            .iter()
            .find(|agent| agent.id == agent_id)
            .cloned()
            .ok_or_else(not_found)?;
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
            permissions: Vec::new(),
        };
        let mut state = self.lock()?;
        if state.closed {
            return Err(unavailable());
        }
        state.entries.insert(
            draft.id,
            Entry {
                agent,
                removed: false,
                state: Arc::new(Mutex::new(ConversationState {
                    snapshot: draft.clone(),
                    generation: 0,
                    subscribers: Vec::new(),
                    permissions: HashMap::new(),
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
        if entry.removed {
            return Err(ConversationError::NotReady("에이전트 삭제로 연결이 종료되었습니다. 설치 상태를 확인하고 새 대화를 시작해주세요.".into()));
        }
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        let mut snapshot = current.snapshot.clone();
        if matches!(
            snapshot.status,
            ConversationStatus::Connecting
                | ConversationStatus::SessionReady
                | ConversationStatus::Running
                | ConversationStatus::WaitingForApproval
                | ConversationStatus::Cancelling
        ) {
            return Ok(snapshot);
        }
        if !snapshot.working_folder.is_dir() {
            return Err(ConversationError::InvalidWorkingFolder(
                "작업 폴더를 찾을 수 없습니다. 폴더를 다시 선택해주세요.".into(),
            ));
        }
        let agent = entry.agent.clone();
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
            authentication: self.authentication.clone(),
            state: entry.state.clone(),
            generation: current.generation,
        };
        let (prompts, requests) = mpsc::unbounded_channel();
        let (cancellations, cancelled) = mpsc::unbounded_channel();
        let folder = snapshot.working_folder.clone();
        entry.runtime = Some(Runtime {
            prompts,
            cancellations,
            stop: Some(stop),
            task: Some(handle.spawn(crate::agent_runtime::run(
                agent, folder, updates, receiver, requests, cancelled,
            ))),
        });
        Ok(snapshot)
    }

    /// Atomically subscribes to a snapshot and every subsequent revision.
    /// Dropping the receiver does not stop the conversation.
    pub fn subscribe(
        &self,
        id: Uuid,
    ) -> Result<mpsc::UnboundedReceiver<ConversationUpdate>, ConversationError> {
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        let (sender, receiver) = mpsc::unbounded_channel();
        let _ = sender.send(ConversationUpdate::Snapshot {
            snapshot: Box::new(current.snapshot.clone()),
        });
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

    /// Cancels the named active turn without replacing its session or history.
    pub fn cancel_turn(&self, id: Uuid, turn: Uuid) -> Result<(), ConversationError> {
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        if current.snapshot.turns.last().map(|item| item.id) != Some(turn) {
            return Err(ConversationError::NotReady(
                "이미 종료된 작업입니다.".into(),
            ));
        }
        if current.snapshot.status == ConversationStatus::Cancelling {
            return Ok(());
        }
        if !matches!(
            current.snapshot.status,
            ConversationStatus::Running | ConversationStatus::WaitingForApproval
        ) {
            return Err(ConversationError::NotReady(
                "진행 중인 작업이 없습니다.".into(),
            ));
        }
        entry
            .runtime
            .as_ref()
            .ok_or_else(unavailable)?
            .cancellations
            .send(turn)
            .map_err(|_| unavailable())?;
        current.snapshot.status = ConversationStatus::Cancelling;
        current.clear_permissions();
        current.publish();
        Ok(())
    }

    /// Consumes one pending request; stale or unadvertised choices are rejected.
    pub fn answer_permission(
        &self,
        id: Uuid,
        request: Uuid,
        option: String,
    ) -> Result<(), ConversationError> {
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        if current.snapshot.status != ConversationStatus::WaitingForApproval
            || !current.snapshot.permissions.iter().any(|permission| {
                permission.id == request
                    && permission.options.iter().any(|choice| choice.id == option)
            })
        {
            return Err(ConversationError::NotReady(
                "이미 해소되었거나 유효하지 않은 승인 선택입니다.".into(),
            ));
        }
        let response = current
            .permissions
            .remove(&request)
            .ok_or_else(unavailable)?;
        let result = response.send(option).map_err(|_| unavailable());
        current
            .snapshot
            .permissions
            .retain(|permission| permission.id != request);
        if current.snapshot.permissions.is_empty() {
            current.snapshot.status = ConversationStatus::Running;
        }
        current.publish();
        result
    }

    /// Stops and reaps all owned processes before application exit.
    pub async fn shutdown(&self) {
        let _lifecycle = self.lifecycle.lock().await;
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
        stop_runtimes(runtimes).await;
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, ConversationError> {
        self.state.lock().map_err(|_| unavailable())
    }
}

async fn stop_runtimes(runtimes: Vec<Runtime>) {
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
    subscribers: Vec<mpsc::UnboundedSender<ConversationUpdate>>,
    permissions: HashMap<Uuid, oneshot::Sender<String>>,
}

impl ConversationState {
    fn clear_permissions(&mut self) {
        // Dropped senders resolve every pending ACP request as cancelled.
        self.permissions.clear();
        self.snapshot.permissions.clear();
    }

    fn publish(&mut self) {
        self.snapshot.revision += 1;
        self.subscribers.retain(|sender| {
            sender
                .send(ConversationUpdate::Snapshot {
                    snapshot: Box::new(self.snapshot.clone()),
                })
                .is_ok()
        });
    }
}

/// Ordered subscription item. Text chunks carry only their delta, not history.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConversationUpdate {
    Snapshot {
        snapshot: Box<Conversation>,
    },
    TextDelta {
        #[serde(rename = "conversationId")]
        conversation_id: Uuid,
        revision: u64,
        #[serde(rename = "turnId")]
        turn_id: Uuid,
        text: String,
    },
}

/// A connection-scoped writer. Retired runtimes cannot overwrite a replacement.
#[derive(Clone)]
pub(crate) struct RuntimeUpdates {
    authentication: Arc<Mutex<HashMap<String, AuthenticationStatus>>>,
    state: Arc<Mutex<ConversationState>>,
    generation: u64,
}

impl RuntimeUpdates {
    pub fn request_permission(
        &self,
        turn: Uuid,
        request: PermissionRequest,
    ) -> Option<oneshot::Receiver<String>> {
        let mut state = self.state.lock().ok()?;
        if state.generation != self.generation
            || !matches!(
                state.snapshot.status,
                ConversationStatus::Running | ConversationStatus::WaitingForApproval
            )
            || state.snapshot.turns.last().map(|item| item.id) != Some(turn)
        {
            return None;
        }
        let (sender, receiver) = oneshot::channel();
        state.permissions.insert(request.id, sender);
        state.snapshot.permissions.push(request);
        state.snapshot.status = ConversationStatus::WaitingForApproval;
        state.publish();
        Some(receiver)
    }

    pub fn record_authentication(&self, status: AuthenticationStatus) {
        let Ok(state) = self.state.lock() else {
            return;
        };
        if state.generation != self.generation {
            return;
        }
        if let Ok(mut authentication) = self.authentication.lock() {
            authentication.insert(state.snapshot.agent_id.clone(), status);
        }
    }

    pub fn append_text(&self, turn: Uuid, text: String) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.generation != self.generation
            || !matches!(
                state.snapshot.status,
                ConversationStatus::Running | ConversationStatus::WaitingForApproval
            )
            || state.snapshot.turns.last().map(|item| item.id) != Some(turn)
        {
            return;
        }
        if let Some(last) = state.snapshot.turns.last_mut() {
            last.response.push_str(&text);
        }
        state.snapshot.revision += 1;
        let change = ConversationUpdate::TextDelta {
            conversation_id: state.snapshot.id,
            revision: state.snapshot.revision,
            turn_id: turn,
            text,
        };
        state
            .subscribers
            .retain(|sender| sender.send(change.clone()).is_ok());
    }

    pub fn modify(&self, turn: Option<Uuid>, update: impl FnOnce(&mut Conversation)) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.generation != self.generation {
            return;
        }
        if let Some(turn) = turn {
            if !matches!(
                state.snapshot.status,
                ConversationStatus::Running
                    | ConversationStatus::WaitingForApproval
                    | ConversationStatus::Cancelling
            ) || state.snapshot.turns.last().map(|item| item.id) != Some(turn)
            {
                return;
            }
        }
        update(&mut state.snapshot);
        if !matches!(
            state.snapshot.status,
            ConversationStatus::Running | ConversationStatus::WaitingForApproval
        ) {
            state.clear_permissions();
        }
        state.publish();
    }
}
