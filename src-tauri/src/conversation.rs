//! Durable conversation identity and in-memory content, independent of desktop transport.
mod list;
use crate::agent::{prepared_codex, AgentDefinition, PreparedAgent};
use crate::storage::{StorageError, Store};
use serde::{Deserialize, Serialize};
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
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub interrupted: bool,
    pub storage_error: Option<String>,
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
    pub queued_messages: Vec<QueuedMessage>,
}

/// Atte-owned input waiting for the active turn to finish, in submission order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedMessage {
    pub id: Uuid,
    pub text: String,
}

/// The entire durable record and list interface. Content never crosses this seam.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: Uuid,
    pub title: String,
    pub working_folder: PathBuf,
    pub agent_id: String,
    pub remote_session_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub status: ConversationStatus,
    pub failure: Option<ConnectionFailure>,
    pub interrupted: bool,
}

impl Conversation {
    fn summary(&self) -> ConversationSummary {
        ConversationSummary {
            id: self.id,
            title: self.title.clone(),
            working_folder: self.working_folder.clone(),
            agent_id: self.agent_id.clone(),
            remote_session_id: self.remote_session_id.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            status: self.status.clone(),
            failure: self.failure.clone(),
            interrupted: self.interrupted,
        }
    }
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
    ResumptionUnsupported,
    SessionRestorationFailed,
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
    list: Arc<Mutex<list::ConversationList>>,
    store: Option<Arc<Store>>,
    agents: Mutex<Vec<AgentDefinition>>,
    lifecycle: tokio::sync::Mutex<()>,
    authentication: Arc<Mutex<HashMap<String, AuthenticationStatus>>>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    entries: HashMap<Uuid, Entry>,
    runtimes: Vec<Runtime>,
    closed: bool,
}

struct Entry {
    state: Arc<Mutex<ConversationState>>,
    runtime: Option<SessionCommands>,
}

struct SessionCommands {
    prompts: mpsc::UnboundedSender<Prompt>,
    cancellations: mpsc::UnboundedSender<Uuid>,
}

struct Runtime {
    agent: AgentDefinition,
    folder: PathBuf,
    sessions: mpsc::UnboundedSender<crate::agent_runtime::Session>,
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
            list: Arc::default(),
            store: None,
            agents: Mutex::new(agents),
            lifecycle: tokio::sync::Mutex::new(()),
            authentication: Arc::default(),
            state: Mutex::new(State::default()),
        }
    }

    /// Restores only metadata. Opening the list never starts an agent process.
    pub fn with_store(
        agents: Vec<AgentDefinition>,
        store: Arc<Store>,
    ) -> Result<Self, StorageError> {
        let mut entries = HashMap::new();
        let list = Arc::new(Mutex::new(list::ConversationList::default()));
        for saved in store.conversations()? {
            let interrupted = saved.interrupted
                || matches!(
                    saved.status,
                    ConversationStatus::Running
                        | ConversationStatus::WaitingForApproval
                        | ConversationStatus::Cancelling
                );
            let snapshot = Conversation {
                id: saved.id,
                title: saved.title,
                working_folder: saved.working_folder,
                agent_id: saved.agent_id,
                remote_session_id: saved.remote_session_id,
                created_at: saved.created_at,
                updated_at: saved.updated_at,
                interrupted,
                storage_error: None,
                status: ConversationStatus::Disconnected,
                authentication: AuthenticationStatus::Unknown,
                failure: saved.failure,
                revision: 0,
                turns: Vec::new(),
                notice: None,
                permissions: Vec::new(),
                queued_messages: store.queued_messages(saved.id)?,
            };
            entries.insert(
                snapshot.id,
                Entry {
                    state: Arc::new(Mutex::new(ConversationState {
                        list: list.clone(),
                        snapshot,
                        generation: 0,
                        subscribers: Vec::new(),
                        permissions: HashMap::new(),
                        store: Some(store.clone()),
                    })),
                    runtime: None,
                },
            );
            list.lock()
                .map_err(|_| StorageError::Unavailable)?
                .entries
                .insert(
                    saved.id,
                    entries[&saved.id]
                        .state
                        .lock()
                        .map_err(|_| StorageError::Unavailable)?
                        .snapshot
                        .summary(),
                );
        }
        Ok(Self {
            list,
            store: Some(store),
            state: Mutex::new(State {
                entries,
                closed: false,
                runtimes: Vec::new(),
            }),
            ..Self::new(agents)
        })
    }

    pub fn list(&self) -> Result<Vec<ConversationSummary>, ConversationError> {
        Ok(self.list.lock().map_err(|_| unavailable())?.snapshot())
    }

    /// Subscribes to list metadata even for conversations that are not open in a view.
    pub fn subscribe_list(
        &self,
    ) -> Result<mpsc::UnboundedReceiver<Vec<ConversationSummary>>, ConversationError> {
        Ok(self.list.lock().map_err(|_| unavailable())?.subscribe())
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
            for entry in state.entries.values_mut() {
                let mut current = entry.state.lock().map_err(|_| unavailable())?;
                if current.snapshot.agent_id != id {
                    continue;
                }
                current.generation += 1;
                current.snapshot.interrupted |= matches!(
                    current.snapshot.status,
                    ConversationStatus::Running
                        | ConversationStatus::WaitingForApproval
                        | ConversationStatus::Cancelling
                );
                current.snapshot.status = ConversationStatus::Failed;
                current.snapshot.failure = Some(ConnectionFailure::AgentRemoved);
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
                entry.runtime = None;
            }
            let mut runtimes = Vec::new();
            let mut index = 0;
            while index < state.runtimes.len() {
                if state.runtimes[index].agent.id == id {
                    runtimes.push(state.runtimes.remove(index));
                } else {
                    index += 1;
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
        let _agent = agents
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
            title: "새 대화".into(),
            created_at: now(),
            updated_at: now(),
            interrupted: false,
            storage_error: None,
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
            queued_messages: Vec::new(),
        };
        let mut state = self.lock()?;
        if state.closed {
            return Err(unavailable());
        }
        if let Some(store) = &self.store {
            store
                .save_conversation(&draft.summary())
                .map_err(|error| ConversationError::Unavailable(error.to_string()))?;
        }
        state.entries.insert(
            draft.id,
            Entry {
                state: Arc::new(Mutex::new(ConversationState {
                    list: self.list.clone(),
                    snapshot: draft.clone(),
                    generation: 0,
                    subscribers: Vec::new(),
                    permissions: HashMap::new(),
                    store: self.store.clone(),
                })),
                runtime: None,
            },
        );
        self.list
            .lock()
            .map_err(|_| unavailable())?
            .publish(draft.summary());
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
        let agents = self.agents.lock().map_err(|_| unavailable())?;
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
        let Some(agent) = agents
            .iter()
            .find(|agent| agent.id == snapshot.agent_id)
            .cloned()
        else {
            if current.snapshot.status != ConversationStatus::Failed
                || current.snapshot.failure != Some(ConnectionFailure::AgentRemoved)
            {
                current.snapshot.status = ConversationStatus::Failed;
                current.snapshot.failure = Some(ConnectionFailure::AgentRemoved);
                current.publish();
            }
            return Err(ConversationError::NotReady(
                "에이전트를 설치한 뒤 다시 시도해주세요.".into(),
            ));
        };
        let handle = tokio::runtime::Handle::try_current().map_err(|_| unavailable())?;
        snapshot.status = ConversationStatus::Connecting;
        snapshot.authentication = AuthenticationStatus::Unknown;
        snapshot.failure = None;
        current.generation += 1;
        current.snapshot = snapshot;
        current.publish();
        let snapshot = current.snapshot.clone();
        let updates = RuntimeUpdates {
            authentication: self.authentication.clone(),
            state: entry.state.clone(),
            generation: current.generation,
        };
        let (prompts, requests) = mpsc::unbounded_channel();
        let (cancellations, cancelled) = mpsc::unbounded_channel();
        let folder = snapshot.working_folder.clone();
        entry.runtime = Some(SessionCommands {
            prompts,
            cancellations,
        });
        drop(current);
        let session = crate::agent_runtime::Session {
            id,
            remote_session: snapshot.remote_session_id.clone(),
            updates,
            prompts: requests,
            cancellations: cancelled,
        };
        let runtime = if let Some(index) = state.runtimes.iter().position(|runtime| {
            runtime.agent == agent
                && runtime.folder == folder
                && !runtime.sessions.is_closed()
                && runtime
                    .task
                    .as_ref()
                    .is_some_and(|task| !task.is_finished())
        }) {
            &mut state.runtimes[index]
        } else {
            let (sessions, receiver) = mpsc::unbounded_channel();
            let (stop, stopped) = oneshot::channel();
            let task = handle.spawn(crate::agent_runtime::run(
                agent.clone(),
                folder.clone(),
                receiver,
                stopped,
            ));
            state.runtimes.push(Runtime {
                agent,
                folder,
                sessions,
                stop: Some(stop),
                task: Some(task),
            });
            state.runtimes.last_mut().ok_or_else(unavailable)?
        };
        if let Err(error) = runtime.sessions.send(session) {
            error.0.updates.modify(None, |snapshot| {
                snapshot.status = ConversationStatus::Failed;
                snapshot.failure = Some(ConnectionFailure::ConnectionClosed);
            });
            return Err(unavailable());
        }
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

    /// Sends while ready, or queues input behind an active turn.
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
        if matches!(
            current.snapshot.status,
            ConversationStatus::Running
                | ConversationStatus::WaitingForApproval
                | ConversationStatus::Cancelling
        ) {
            let mut queue = current.snapshot.queued_messages.clone();
            queue.push(QueuedMessage {
                id: Uuid::new_v4(),
                text,
            });
            current.save_queue(queue)?;
            current.publish();
            return Ok(());
        }
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
        current.snapshot.interrupted = false;
        if current.snapshot.title == "새 대화" {
            current.snapshot.title = text.trim().chars().take(60).collect();
        }
        current.snapshot.turns.push(Turn {
            id: turn,
            message: text,
            response: String::new(),
            stop_reason: None,
        });
        current.publish();
        Ok(())
    }

    /// Deletes only input that has not yet been removed for dispatch.
    pub fn delete_queued_message(&self, id: Uuid, message: Uuid) -> Result<(), ConversationError> {
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        let mut queue = current.snapshot.queued_messages.clone();
        let index = queue
            .iter()
            .position(|item| item.id == message)
            .ok_or_else(|| {
                ConversationError::NotReady("이미 전송되었거나 삭제된 메시지입니다.".into())
            })?;
        queue.remove(index);
        current.save_queue(queue)?;
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
            for entry in state.entries.values_mut() {
                if let Ok(mut current) = entry.state.lock() {
                    current.snapshot.interrupted |= matches!(
                        current.snapshot.status,
                        ConversationStatus::Running
                            | ConversationStatus::WaitingForApproval
                            | ConversationStatus::Cancelling
                    );
                    current.snapshot.status = ConversationStatus::Disconnected;
                    current.clear_permissions();
                    current.publish();
                    current.generation += 1;
                }
                entry.runtime = None;
            }
            std::mem::take(&mut state.runtimes)
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
    list: Arc<Mutex<list::ConversationList>>,
    store: Option<Arc<Store>>,
    snapshot: Conversation,
    generation: u64,
    subscribers: Vec<mpsc::UnboundedSender<ConversationUpdate>>,
    permissions: HashMap<Uuid, oneshot::Sender<String>>,
}

impl ConversationState {
    fn save_queue(&mut self, queue: Vec<QueuedMessage>) -> Result<(), ConversationError> {
        if let Some(store) = &self.store {
            store
                .save_queue(&self.snapshot.summary(), &queue)
                .map_err(|error| ConversationError::Unavailable(error.to_string()))?;
        }
        self.snapshot.queued_messages = queue;
        Ok(())
    }

    fn clear_permissions(&mut self) {
        // Dropped senders resolve every pending ACP request as cancelled.
        self.permissions.clear();
        self.snapshot.permissions.clear();
    }

    fn publish(&mut self) {
        self.snapshot.updated_at = now();
        if let Some(store) = &self.store {
            self.snapshot.storage_error = store
                .save_conversation(&self.snapshot.summary())
                .err()
                .map(|error| error.to_string());
        }
        self.snapshot.revision += 1;
        if let Ok(mut list) = self.list.lock() {
            list.publish(self.snapshot.summary());
        }
        self.subscribers.retain(|sender| {
            sender
                .send(ConversationUpdate::Snapshot {
                    snapshot: Box::new(self.snapshot.clone()),
                })
                .is_ok()
        });
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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
    pub fn complete_turn(
        &self,
        turn: Uuid,
        reason: agent_client_protocol::schema::v1::StopReason,
    ) -> Option<Prompt> {
        let mut state = self.state.lock().ok()?;
        if state.generation != self.generation
            || !matches!(
                state.snapshot.status,
                ConversationStatus::Running
                    | ConversationStatus::WaitingForApproval
                    | ConversationStatus::Cancelling
            )
            || state.snapshot.turns.last().map(|item| item.id) != Some(turn)
        {
            return None;
        }
        let cancelled = state.snapshot.status == ConversationStatus::Cancelling;
        state.snapshot.interrupted =
            cancelled || reason == agent_client_protocol::schema::v1::StopReason::Cancelled;
        if let Some(turn) = state.snapshot.turns.last_mut() {
            turn.stop_reason = serde_json::to_value(reason)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned));
        }
        state.snapshot.status = ConversationStatus::SessionReady;
        state.snapshot.authentication = AuthenticationStatus::Authenticated;
        state.clear_permissions();
        let next = if !cancelled
            && reason == agent_client_protocol::schema::v1::StopReason::EndTurn
            && !state.snapshot.queued_messages.is_empty()
        {
            let mut queue = state.snapshot.queued_messages.clone();
            let queued = queue.remove(0);
            if let Err(error) = state.save_queue(queue) {
                state.snapshot.notice = Some(error.to_string());
                state.publish();
                return None;
            }
            let turn = Uuid::new_v4();
            state.snapshot.status = ConversationStatus::Running;
            state.snapshot.turns.push(Turn {
                id: turn,
                message: queued.text.clone(),
                response: String::new(),
                stop_reason: None,
            });
            Some(Prompt {
                turn,
                text: queued.text,
            })
        } else {
            None
        };
        state.publish();
        next
    }

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
