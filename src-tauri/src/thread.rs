//! Durable thread identity and in-memory content, independent of desktop transport.
mod list;
use crate::agent::{prepared_codex, AgentDefinition, PreparedAgent};
use crate::agent_management::authentication::AuthenticationObservation;
use crate::file_selection::MediaStore;
use crate::storage::{StorageError, Store};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

static LAST_PROMPT_AT: AtomicU64 = AtomicU64::new(0);

/// A local thread. Creation does not establish an agent session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// App-owned identifier, independent of any remote session.
    pub id: Uuid,
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    /// Last input dispatch attempt in Unix milliseconds; absent until the first attempt.
    pub last_prompt_at: Option<u64>,
    pub interrupted: bool,
    pub storage_error: Option<String>,
    /// Absolute working directory.
    pub working_folder: PathBuf,
    /// Fixed execution target for this thread.
    pub agent_id: String,
    /// Connection state owned by the application.
    pub status: ThreadStatus,
    /// Agent-issued ID, scoped by this thread's fixed agent and runtime.
    pub session_id: Option<String>,
    /// Connection success is not proof of authentication.
    pub authentication: AuthenticationStatus,
    pub failure: Option<ConnectionFailure>,
    /// Last normally completed response in this app run; never persisted.
    pub completed_turn_id: Option<Uuid>,
    /// Current prompt failure, independent of connection recovery and notices.
    pub request_failure: Option<ConnectionFailure>,
    pub turns: Vec<Turn>,
    pub notice: Option<String>,
    pub permissions: Vec<PermissionRequest>,
    pub queued_messages: Vec<QueuedMessage>,
    pub configuration: Vec<ThreadConfiguration>,
    pub prompt_capabilities: PromptCapabilities,
}

/// Current thread fields excluding the potentially large transcript.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPatch {
    #[serde(flatten)]
    pub metadata: ThreadMetadata,
    pub storage_error: Option<String>,
    pub authentication: AuthenticationStatus,
    pub notice: Option<String>,
    pub permissions: Vec<PermissionRequest>,
    pub queued_messages: Vec<QueuedMessage>,
    pub configuration: Vec<ThreadConfiguration>,
    pub prompt_capabilities: PromptCapabilities,
}

impl From<&Thread> for ThreadPatch {
    fn from(thread: &Thread) -> Self {
        Self {
            metadata: thread.metadata(),
            storage_error: thread.storage_error.clone(),
            authentication: thread.authentication.clone(),
            notice: thread.notice.clone(),
            permissions: thread.permissions.clone(),
            queued_messages: thread.queued_messages.clone(),
            configuration: thread.configuration.clone(),
            prompt_capabilities: thread.prompt_capabilities.clone(),
        }
    }
}

impl ThreadPatch {
    /// Applies this transport patch without touching the transcript.
    pub fn apply_to(self, thread: &mut Thread) -> bool {
        if self.metadata.id != thread.id {
            return false;
        }
        let ThreadMetadata {
            id: _,
            title,
            working_folder,
            agent_id,
            session_id,
            created_at,
            updated_at,
            last_prompt_at,
            status,
            failure,
            completed_turn_id,
            request_failure,
            interrupted,
        } = self.metadata;
        thread.title = title;
        thread.working_folder = working_folder;
        thread.agent_id = agent_id;
        thread.session_id = session_id;
        thread.created_at = created_at;
        thread.updated_at = updated_at;
        thread.last_prompt_at = last_prompt_at;
        thread.status = status;
        thread.failure = failure;
        thread.completed_turn_id = completed_turn_id;
        thread.request_failure = request_failure;
        thread.interrupted = interrupted;
        thread.storage_error = self.storage_error;
        thread.authentication = self.authentication;
        thread.notice = self.notice;
        thread.permissions = self.permissions;
        thread.queued_messages = self.queued_messages;
        thread.configuration = self.configuration;
        thread.prompt_capabilities = self.prompt_capabilities;
        true
    }
}

/// Agent-provided configuration for one ACP session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadConfiguration {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    #[serde(flatten)]
    pub control: ThreadConfigurationControl,
}

impl ThreadConfiguration {
    fn accepts(&self, value: &ThreadConfigurationValue) -> bool {
        match (&self.control, value) {
            (
                ThreadConfigurationControl::Select { options, .. },
                ThreadConfigurationValue::Select { value },
            ) => match options {
                ThreadConfigurationSelectOptions::Flat { options } => {
                    options.iter().any(|choice| choice.value == *value)
                }
                ThreadConfigurationSelectOptions::Grouped { groups } => groups
                    .iter()
                    .flat_map(|group| &group.options)
                    .any(|choice| choice.value == *value),
            },
            (
                ThreadConfigurationControl::Boolean { .. },
                ThreadConfigurationValue::Boolean { .. },
            ) => true,
            _ => false,
        }
    }

    fn has_value(&self, value: &ThreadConfigurationValue) -> bool {
        match (&self.control, value) {
            (
                ThreadConfigurationControl::Select { current_value, .. },
                ThreadConfigurationValue::Select { value },
            ) => current_value == value,
            (
                ThreadConfigurationControl::Boolean { current_value },
                ThreadConfigurationValue::Boolean { value },
            ) => current_value == value,
            _ => false,
        }
    }

    fn set_value(&mut self, value: &ThreadConfigurationValue) {
        match (&mut self.control, value) {
            (
                ThreadConfigurationControl::Select { current_value, .. },
                ThreadConfigurationValue::Select { value },
            ) => current_value.clone_from(value),
            (
                ThreadConfigurationControl::Boolean { current_value },
                ThreadConfigurationValue::Boolean { value },
            ) => *current_value = *value,
            _ => {}
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
/// The interaction kind and confirmed value for an agent configuration option.
pub enum ThreadConfigurationControl {
    Select {
        #[serde(rename = "currentValue")]
        current_value: String,
        options: ThreadConfigurationSelectOptions,
    },
    Boolean {
        #[serde(rename = "currentValue")]
        current_value: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
/// Flat or agent-grouped choices for a select configuration option.
pub enum ThreadConfigurationSelectOptions {
    Flat {
        options: Vec<ThreadConfigurationChoice>,
    },
    Grouped {
        groups: Vec<ThreadConfigurationGroup>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
/// One opaque select value and its agent-provided presentation metadata.
pub struct ThreadConfigurationChoice {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
/// An agent-provided group of related select choices.
pub struct ThreadConfigurationGroup {
    pub id: String,
    pub name: String,
    pub options: Vec<ThreadConfigurationChoice>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
/// A typed value sent unchanged to ACP when a user changes an option.
pub enum ThreadConfigurationValue {
    Select { value: String },
    Boolean { value: bool },
}

/// Atte-owned input waiting for the active turn to finish, in submission order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedMessage {
    pub id: Uuid,
    #[serde(flatten)]
    pub input: UserInput,
    #[serde(default)]
    pub status: QueuedMessageStatus,
}

impl QueuedMessage {
    /// Creates a backward-compatible text-only queued input.
    pub fn text(id: Uuid, body: impl Into<String>) -> Self {
        Self {
            id,
            input: UserInput::text(body.into()),
            status: QueuedMessageStatus::Pending,
        }
    }
}

/// One user submission, preserving attachment order independently from its message body.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserInput {
    #[serde(rename = "text", alias = "body")]
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

impl UserInput {
    fn text(body: String) -> Self {
        Self {
            body,
            attachments: Vec::new(),
        }
    }
}

/// Metadata for one ordered prompt attachment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: Uuid,
    pub name: String,
    #[serde(default)]
    pub kind: AttachmentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

impl Attachment {
    /// Creates a linked-file attachment from its display name and URI.
    pub fn file(id: Uuid, name: impl Into<String>, uri: impl Into<String>) -> Self {
        Self {
            id,
            name: name.into(),
            kind: AttachmentKind::File,
            uri: Some(uri.into()),
            mime_type: None,
        }
    }

    /// Creates an image or audio attachment backed by an app-managed snapshot.
    pub fn media(
        id: Uuid,
        name: impl Into<String>,
        kind: MediaKind,
        mime_type: impl Into<String>,
    ) -> Self {
        Self {
            id,
            name: name.into(),
            kind: kind.into(),
            uri: None,
            mime_type: Some(mime_type.into()),
        }
    }
}

/// The ACP content representation used for an attachment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentKind {
    #[default]
    File,
    Image,
    Audio,
}

/// An attachment kind that ACP carries as inline content.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Image,
    Audio,
}

impl From<MediaKind> for AttachmentKind {
    fn from(kind: MediaKind) -> Self {
        match kind {
            MediaKind::Image => Self::Image,
            MediaKind::Audio => Self::Audio,
        }
    }
}

/// Media input types advertised by the active ACP session.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCapabilities {
    pub image: bool,
    pub audio: bool,
}

/// A queued input blocks later input after a delivery failure.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueuedMessageStatus {
    #[default]
    Pending,
    Failed,
}

/// Metadata for listing and reconnecting threads, excluding content and queued input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadata {
    pub id: Uuid,
    pub title: String,
    pub working_folder: PathBuf,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub last_prompt_at: Option<u64>,
    pub status: ThreadStatus,
    pub failure: Option<ConnectionFailure>,
    #[serde(skip_deserializing)]
    pub completed_turn_id: Option<Uuid>,
    #[serde(skip_deserializing)]
    pub request_failure: Option<ConnectionFailure>,
    pub interrupted: bool,
}

impl Thread {
    fn metadata(&self) -> ThreadMetadata {
        ThreadMetadata {
            id: self.id,
            title: self.title.clone(),
            working_folder: self.working_folder.clone(),
            agent_id: self.agent_id.clone(),
            session_id: self.session_id.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            last_prompt_at: self.last_prompt_at,
            status: self.status.clone(),
            failure: self.failure.clone(),
            completed_turn_id: self.completed_turn_id,
            request_failure: self.request_failure.clone(),
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
pub enum ThreadStatus {
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
pub enum ThreadError {
    /// The working folder is not an existing local directory.
    #[error("{0}")]
    InvalidWorkingFolder(String),
    /// The requested app thread does not exist.
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

/// Owns thread state and agent runtime lifetimes.
pub struct Threads {
    list: Arc<Mutex<list::ThreadList>>,
    store: Option<Arc<Store>>,
    media_store: Option<Arc<MediaStore>>,
    agents: Mutex<Vec<AgentDefinition>>,
    lifecycle: tokio::sync::Mutex<()>,
    shutdown: CancellationToken,
    runtime_stop_failures: AtomicU64,
    authentication: Arc<Mutex<HashMap<String, AuthenticationStatus>>>,
    authentication_observations: Arc<Mutex<HashMap<String, AuthenticationObservation>>>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    entries: HashMap<Uuid, Entry>,
    runtimes: Vec<Runtime>,
    agent_transitions: HashMap<String, AgentTransition>,
    closed: bool,
}

#[derive(Default)]
struct AgentTransition {
    draining: bool,
    resume: HashSet<Uuid>,
}

struct Entry {
    state: Arc<Mutex<ThreadState>>,
    runtime: Option<SessionCommands>,
}

struct SessionCommands {
    inputs: crate::agent_runtime::SessionInputSenders,
    runtime: mpsc::UnboundedSender<crate::agent_runtime::RuntimeCommand>,
}

struct Runtime {
    agent: AgentDefinition,
    folder: PathBuf,
    commands: mpsc::UnboundedSender<crate::agent_runtime::RuntimeCommand>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<bool>>,
    pid: Arc<AtomicU32>,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

fn runtime_for(
    state: &mut State,
    handle: &tokio::runtime::Handle,
    agent: AgentDefinition,
    folder: PathBuf,
    authentication: Arc<Mutex<HashMap<String, AuthenticationStatus>>>,
    authentication_observations: Arc<Mutex<HashMap<String, AuthenticationObservation>>>,
) -> mpsc::UnboundedSender<crate::agent_runtime::RuntimeCommand> {
    if let Some(runtime) = state.runtimes.iter().find(|runtime| {
        same_agent_definition(&runtime.agent, &agent)
            && runtime.folder == folder
            && !runtime.commands.is_closed()
            && runtime
                .task
                .as_ref()
                .is_some_and(|task| !task.is_finished())
    }) {
        return runtime.commands.clone();
    }
    let (commands, receiver) = mpsc::unbounded_channel();
    let (stop, stopped) = oneshot::channel();
    let pid = Arc::new(AtomicU32::new(0));
    let task = handle.spawn(crate::agent_runtime::run(
        agent.clone(),
        folder.clone(),
        receiver,
        stopped,
        pid.clone(),
        authentication,
        authentication_observations,
    ));
    state.runtimes.push(Runtime {
        agent,
        folder,
        commands: commands.clone(),
        stop: Some(stop),
        task: Some(task),
        pid,
    });
    commands
}

fn same_agent_definition(left: &AgentDefinition, right: &AgentDefinition) -> bool {
    left.id == right.id
        && left.name == right.name
        && left.launch_kind == right.launch_kind
        && left.command == right.command
        && left.args == right.args
        && left.env == right.env
}

impl Default for Threads {
    fn default() -> Self {
        Self::new(vec![prepared_codex()])
    }
}

impl Threads {
    pub(crate) fn media_store(&self) -> Option<Arc<MediaStore>> {
        self.media_store.clone()
    }

    pub(crate) fn supports_attachment(
        &self,
        id: Uuid,
        kind: AttachmentKind,
    ) -> Result<bool, ThreadError> {
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let current = entry.state.lock().map_err(|_| unavailable())?;
        Ok(match kind {
            AttachmentKind::File => true,
            AttachmentKind::Image => current.thread.prompt_capabilities.image,
            AttachmentKind::Audio => current.thread.prompt_capabilities.audio,
        })
    }

    /// Uses trusted launch definitions supplied by the outer application adapter.
    pub fn new(agents: Vec<AgentDefinition>) -> Self {
        Self {
            list: Arc::default(),
            store: None,
            media_store: None,
            agents: Mutex::new(agents),
            lifecycle: tokio::sync::Mutex::new(()),
            shutdown: CancellationToken::new(),
            runtime_stop_failures: AtomicU64::new(0),
            authentication: Arc::default(),
            authentication_observations: Arc::default(),
            state: Mutex::new(State::default()),
        }
    }

    /// Restores only metadata. Opening the list never starts an agent process.
    pub fn with_store(
        agents: Vec<AgentDefinition>,
        store: Arc<Store>,
    ) -> Result<Self, StorageError> {
        let media_store = Arc::new(MediaStore::new(store.root().join("prompt-attachments")));
        let mut entries = HashMap::new();
        let list = Arc::new(Mutex::new(list::ThreadList::default()));
        for saved in store.threads()? {
            let last_prompt_at = saved.last_prompt_at;
            if let Some(timestamp) = last_prompt_at {
                LAST_PROMPT_AT.fetch_max(timestamp, Ordering::Relaxed);
            }
            let interrupted = saved.interrupted
                || matches!(
                    saved.status,
                    ThreadStatus::Running
                        | ThreadStatus::WaitingForApproval
                        | ThreadStatus::Cancelling
                );
            let thread = Thread {
                id: saved.id,
                title: saved.title,
                working_folder: saved.working_folder,
                agent_id: saved.agent_id,
                session_id: saved.session_id,
                created_at: saved.created_at,
                updated_at: saved.updated_at,
                last_prompt_at,
                interrupted,
                storage_error: None,
                status: if saved.status == ThreadStatus::Failed {
                    ThreadStatus::Failed
                } else {
                    ThreadStatus::Disconnected
                },
                authentication: AuthenticationStatus::Unknown,
                failure: saved.failure,
                completed_turn_id: None,
                request_failure: None,
                turns: Vec::new(),
                notice: None,
                permissions: Vec::new(),
                queued_messages: store.queued_messages(saved.id)?,
                configuration: Vec::new(),
                prompt_capabilities: PromptCapabilities::default(),
            };
            entries.insert(
                thread.id,
                Entry {
                    state: Arc::new(Mutex::new(ThreadState {
                        list: list.clone(),
                        use_prompt_title: false,
                        published_failure: thread.failure.clone(),
                        pending_errors: Vec::new(),
                        thread,
                        confirmed_configuration: Vec::new(),
                        desired_configuration: HashMap::new(),
                        generation: 0,
                        subscribers: Vec::new(),
                        permissions: HashMap::new(),
                        store: Some(store.clone()),
                        media_store: Some(media_store.clone()),
                        draining: false,
                        dispatch_queue_on_ready: false,
                        dispatching_queued: None,
                        published_turn_count: 0,
                        published_last_turn: None,
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
                        .thread
                        .metadata(),
                );
        }
        Ok(Self {
            list,
            store: Some(store),
            media_store: Some(media_store),
            state: Mutex::new(State {
                entries,
                closed: false,
                runtimes: Vec::new(),
                agent_transitions: HashMap::new(),
            }),
            ..Self::new(agents)
        })
    }

    pub fn list(&self) -> Result<Vec<ThreadMetadata>, ThreadError> {
        Ok(self
            .list
            .lock()
            .map_err(|_| unavailable())?
            .sorted_entries())
    }

    /// Subscribes to list metadata even for threads that are not open in a view.
    pub fn subscribe_list(
        &self,
    ) -> Result<mpsc::UnboundedReceiver<Vec<ThreadMetadata>>, ThreadError> {
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

    /// Latest authentication evidence from setup or an actual thread request.
    pub fn authentication_status(&self, agent_id: &str) -> Option<AuthenticationStatus> {
        self.authentication.lock().ok()?.get(agent_id).cloned()
    }

    pub(crate) fn record_authentication(&self, agent_id: &str, status: AuthenticationStatus) {
        if let Ok(mut authentication) = self.authentication.lock() {
            authentication.insert(agent_id.into(), status);
        }
    }

    pub(crate) fn authentication_observation(
        &self,
        agent_id: &str,
    ) -> Option<AuthenticationObservation> {
        self.authentication_observations
            .lock()
            .ok()?
            .get(agent_id)
            .cloned()
    }

    pub(crate) fn clear_authentication_evidence(&self, agent_id: &str) {
        self.record_authentication(agent_id, AuthenticationStatus::Unknown);
        if let Ok(mut observations) = self.authentication_observations.lock() {
            if let Some(observation) = observations.get_mut(agent_id) {
                observation.status_reported = false;
                observation.email = None;
                observation.plan = None;
            }
        }
    }

    /// Publishes an installed execution definition without replacing thread state.
    pub fn register_agent(&self, agent: AgentDefinition) -> Result<(), ThreadError> {
        let mut agents = self.agents.lock().map_err(|_| unavailable())?;
        if let Some(existing) = agents.iter_mut().find(|entry| entry.id == agent.id) {
            *existing = agent;
        } else {
            agents.push(agent);
        }
        Ok(())
    }

    /// Stops this agent's idle runtimes and swaps its definition while no turn is active.
    pub async fn replace_agent_if_idle(
        &self,
        id: &str,
        activate: impl FnOnce() -> Result<AgentDefinition, ThreadError>,
    ) -> Result<bool, ThreadError> {
        let _lifecycle = self.lifecycle.lock().await;
        let runtimes = {
            let mut state = self.lock()?;
            let has_active_turn = state.entries.values().any(|entry| {
                entry.state.lock().is_ok_and(|current| {
                    current.thread.agent_id == id
                        && matches!(
                            current.thread.status,
                            ThreadStatus::Running
                                | ThreadStatus::WaitingForApproval
                                | ThreadStatus::Cancelling
                        )
                })
            });
            if has_active_turn {
                return Ok(false);
            }
            for entry in state.entries.values_mut() {
                let mut current = entry.state.lock().map_err(|_| unavailable())?;
                if current.thread.agent_id == id {
                    current.generation += 1;
                    current.thread.status = ThreadStatus::Disconnected;
                    current.clear_configuration();
                    current.clear_permissions();
                    current.publish();
                    entry.runtime = None;
                }
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
        if let Err(runtimes) = self.stop_runtimes(runtimes).await {
            self.restore_runtimes(runtimes);
            return Err(unavailable());
        }
        self.register_agent(activate()?)?;
        Ok(true)
    }

    /// Drains every thread using an agent before replacing its execution definition.
    ///
    /// New connections and queued input remain blocked from the old definition until
    /// all active turns finish and every owned runtime has been reaped.
    pub async fn drain_and_replace_agent(
        &self,
        id: &str,
        activate: impl FnOnce() -> Result<AgentDefinition, ThreadError>,
    ) -> Result<(), ThreadError> {
        self.drain_and_replace_agent_until(id, &CancellationToken::new(), activate)
            .await
    }

    /// Drains and replaces one agent unless the owning management operation is cancelled.
    pub async fn drain_and_replace_agent_until(
        &self,
        id: &str,
        cancellation: &CancellationToken,
        activate: impl FnOnce() -> Result<AgentDefinition, ThreadError>,
    ) -> Result<(), ThreadError> {
        let _lifecycle = self.lifecycle.lock().await;
        let mut updates = self.subscribe_list()?;
        {
            let mut state = self.lock()?;
            let transition = state.agent_transitions.entry(id.into()).or_default();
            if transition.draining {
                return Err(unavailable());
            }
            transition.draining = true;
            for entry in state.entries.values() {
                let mut current = entry.state.lock().map_err(|_| unavailable())?;
                if current.thread.agent_id == id {
                    current.draining = true;
                }
            }
        }
        loop {
            let active = self.lock()?.entries.values().any(|entry| {
                entry.state.lock().is_ok_and(|current| {
                    current.thread.agent_id == id
                        && matches!(
                            current.thread.status,
                            ThreadStatus::Running
                                | ThreadStatus::WaitingForApproval
                                | ThreadStatus::Cancelling
                        )
                })
            });
            if !active {
                break;
            }
            tokio::select! {
                _ = self.shutdown.cancelled() => {
                    self.clear_draining(id);
                    return Err(unavailable());
                }
                _ = cancellation.cancelled() => {
                    self.clear_draining(id);
                    return Err(unavailable());
                }
                update = updates.recv() => {
                    update.ok_or_else(unavailable)?;
                }
            }
        }
        let runtimes = {
            let mut state = self.lock()?;
            let mut resume = Vec::new();
            for (thread_id, entry) in &mut state.entries {
                let mut current = entry.state.lock().map_err(|_| unavailable())?;
                if current.thread.agent_id != id {
                    continue;
                }
                if entry.runtime.take().is_some() {
                    resume.push(*thread_id);
                }
                current.generation += 1;
                current.thread.status = ThreadStatus::Disconnected;
                current.clear_permissions();
                current.publish();
            }
            state
                .agent_transitions
                .entry(id.into())
                .or_default()
                .resume
                .extend(resume);
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
        if let Err(runtimes) = self.stop_runtimes(runtimes).await {
            self.restore_runtimes(runtimes);
            self.clear_draining(id);
            return Err(unavailable());
        }
        if cancellation.is_cancelled() || self.shutdown.is_cancelled() {
            self.clear_draining(id);
            return Err(unavailable());
        }
        let definition = match activate() {
            Ok(definition) => definition,
            Err(error) => {
                self.clear_draining(id);
                return Err(error);
            }
        };
        self.register_agent(definition)?;
        self.finish_draining(id);
        Ok(())
    }

    fn finish_draining(&self, id: &str) {
        if self.shutdown.is_cancelled() {
            self.clear_draining(id);
            return;
        }
        let mut resume = Vec::new();
        if let Ok(mut state) = self.state.lock() {
            resume.extend(
                state
                    .agent_transitions
                    .remove(id)
                    .into_iter()
                    .flat_map(|transition| transition.resume),
            );
            for thread_id in &resume {
                if let Some(entry) = state.entries.get(thread_id) {
                    if let Ok(mut current) = entry.state.lock() {
                        current.dispatch_queue_on_ready = true;
                    }
                }
            }
            for entry in state.entries.values() {
                if let Ok(mut current) = entry.state.lock() {
                    if current.thread.agent_id == id {
                        current.draining = false;
                    }
                }
            }
        }
        for thread_id in resume {
            let _ = self.connect(thread_id);
        }
    }

    fn clear_draining(&self, id: &str) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(transition) = state.agent_transitions.get_mut(id) {
                transition.draining = false;
                if transition.resume.is_empty() {
                    state.agent_transitions.remove(id);
                }
            }
            for entry in state.entries.values() {
                if let Ok(mut current) = entry.state.lock() {
                    if current.thread.agent_id == id {
                        current.draining = false;
                    }
                }
            }
        }
    }

    fn restore_runtimes(&self, runtimes: Vec<Runtime>) {
        if let Ok(mut state) = self.state.lock() {
            state.runtimes.extend(runtimes);
        }
    }

    async fn stop_runtimes(&self, runtimes: Vec<Runtime>) -> Result<(), Vec<Runtime>> {
        if self
            .runtime_stop_failures
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            return Err(runtimes);
        }
        stop_runtimes(runtimes).await
    }

    /// Injects one pre-reap failure for lifecycle boundary regression tests.
    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub fn fail_next_runtime_stop_for_test(&self) {
        self.runtime_stop_failures.fetch_add(1, Ordering::Release);
    }

    /// Retires this agent's threads and reaps their processes before file removal.
    pub async fn unregister_agent(&self, id: &str) -> Result<(), ThreadError> {
        let _lifecycle = self.lifecycle.lock().await;
        let runtimes = {
            let mut agents = self.agents.lock().map_err(|_| unavailable())?;
            let mut state = self.lock()?;
            agents.retain(|agent| agent.id != id);
            state.agent_transitions.remove(id);
            for entry in state.entries.values_mut() {
                let mut current = entry.state.lock().map_err(|_| unavailable())?;
                if current.thread.agent_id != id {
                    continue;
                }
                current.generation += 1;
                current.thread.interrupted |= matches!(
                    current.thread.status,
                    ThreadStatus::Running
                        | ThreadStatus::WaitingForApproval
                        | ThreadStatus::Cancelling
                );
                current.thread.status = ThreadStatus::Failed;
                current.clear_configuration();
                current.thread.failure = Some(ConnectionFailure::AgentRemoved);
                current.thread.authentication = AuthenticationStatus::Unknown;
                current.clear_permissions();
                if let Some(turn) = current
                    .thread
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
        if let Err(runtimes) = self.stop_runtimes(runtimes).await {
            self.restore_runtimes(runtimes);
            return Err(unavailable());
        }
        Ok(())
    }

    /// Creates a disconnected draft assigned to the first prepared target.
    ///
    /// # Errors
    /// Returns an error if the folder is invalid or application state is unavailable.
    pub fn create(&self, folder: &Path) -> Result<Thread, ThreadError> {
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
    pub fn create_for_agent(&self, folder: &Path, agent_id: &str) -> Result<Thread, ThreadError> {
        // Keep this guard until insertion so unregister cannot miss a new owner.
        let agents = self.agents.lock().map_err(|_| unavailable())?;
        let _agent = agents
            .iter()
            .find(|agent| agent.id == agent_id)
            .cloned()
            .ok_or_else(not_found)?;
        if !folder.is_dir() {
            return Err(ThreadError::InvalidWorkingFolder(
                "존재하는 작업 폴더를 선택해주세요.".into(),
            ));
        }
        let created_at = now();
        let draft = Thread {
            id: Uuid::new_v4(),
            title: "새 스레드".into(),
            created_at,
            updated_at: created_at,
            last_prompt_at: None,
            interrupted: false,
            storage_error: None,
            working_folder: folder.canonicalize().map_err(|_| {
                ThreadError::InvalidWorkingFolder("작업 폴더를 찾을 수 없습니다.".into())
            })?,
            agent_id: agent_id.into(),
            status: ThreadStatus::Disconnected,
            session_id: None,
            authentication: AuthenticationStatus::Unknown,
            failure: None,
            completed_turn_id: None,
            request_failure: None,
            turns: Vec::new(),
            notice: None,
            permissions: Vec::new(),
            queued_messages: Vec::new(),
            configuration: Vec::new(),
            prompt_capabilities: PromptCapabilities::default(),
        };
        let mut state = self.lock()?;
        if state.closed {
            return Err(unavailable());
        }
        if let Some(store) = &self.store {
            store
                .save_thread(&draft.metadata())
                .map_err(|error| ThreadError::Unavailable(error.to_string()))?;
        }
        state.entries.insert(
            draft.id,
            Entry {
                state: Arc::new(Mutex::new(ThreadState {
                    list: self.list.clone(),
                    use_prompt_title: true,
                    thread: draft.clone(),
                    published_failure: None,
                    pending_errors: Vec::new(),
                    confirmed_configuration: Vec::new(),
                    desired_configuration: HashMap::new(),
                    generation: 0,
                    subscribers: Vec::new(),
                    permissions: HashMap::new(),
                    store: self.store.clone(),
                    media_store: self.media_store.clone(),
                    draining: false,
                    dispatch_queue_on_ready: false,
                    dispatching_queued: None,
                    published_turn_count: 0,
                    published_last_turn: None,
                })),
                runtime: None,
            },
        );
        self.list
            .lock()
            .map_err(|_| unavailable())?
            .publish(draft.metadata());
        Ok(draft)
    }

    /// Retrieves the current thread by its app-owned ID.
    ///
    /// # Errors
    /// Returns an error for an unknown ID or unavailable application state.
    pub fn get(&self, id: Uuid) -> Result<Thread, ThreadError> {
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let thread = entry
            .state
            .lock()
            .map_err(|_| unavailable())?
            .thread
            .clone();
        Ok(thread)
    }

    /// Permanently removes one app-owned thread locally, then requests remote cleanup.
    ///
    /// # Errors
    /// Returns an error without changing in-memory state when local persistence fails.
    pub fn delete(&self, id: Uuid) -> Result<(), ThreadError> {
        let agents = self.agents.lock().map_err(|_| unavailable())?;
        let mut state = self.lock()?;
        let entry = state.entries.get_mut(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        let session_id = current.thread.session_id.clone();
        let agent = session_id.as_ref().and_then(|_| {
            agents
                .iter()
                .find(|agent| agent.id == current.thread.agent_id)
                .cloned()
        });
        let agent_available = agent.is_some();
        let folder = current.thread.working_folder.clone();
        let mut list = self.list.lock().map_err(|_| unavailable())?;
        if let Some(store) = &self.store {
            store
                .delete_thread(id)
                .map_err(|error| ThreadError::Unavailable(error.to_string()))?;
        }
        current.generation += 1;
        current.clear_permissions();
        current.subscribers.clear();
        drop(current);
        let mut removed = state.entries.remove(&id).ok_or_else(not_found)?;
        list.remove(id);
        if let Some(store) = &self.media_store {
            store.cleanup_orphans(id, []);
        }
        if let Some(session_id) = session_id {
            let (runtime, inputs_to_close) =
                if let Some(SessionCommands { inputs, runtime }) = removed.runtime.take() {
                    (Some(runtime), Some(inputs))
                } else if let Some(agent) = agent {
                    let runtime = tokio::runtime::Handle::try_current().ok().map(|handle| {
                        runtime_for(
                            &mut state,
                            &handle,
                            agent,
                            folder,
                            self.authentication.clone(),
                            self.authentication_observations.clone(),
                        )
                    });
                    (runtime, None)
                } else {
                    (None, None)
                };
            let Some(runtime) = runtime else {
                if agent_available {
                    eprintln!("ACP session deletion could not be started");
                }
                return Ok(());
            };
            if runtime
                .send(crate::agent_runtime::RuntimeCommand::DeleteSession {
                    owner: id,
                    session_id,
                    inputs_to_close,
                })
                .is_err()
            {
                eprintln!("ACP session deletion could not be queued");
            }
        }
        drop(removed);
        Ok(())
    }

    /// Starts one connection attempt. Concurrent requests return the same state.
    /// Requires a Tokio runtime; failures are observed through `get`.
    pub fn connect(&self, id: Uuid) -> Result<Thread, ThreadError> {
        self.connect_inner(id, false)
    }

    /// Replaces an idle connection, recreating failed sessions only before any prompt attempt.
    ///
    /// # Errors
    /// Returns an error if work is active, or connection preparation fails.
    pub fn reconnect(&self, id: Uuid) -> Result<Thread, ThreadError> {
        self.connect_inner(id, true)
    }

    fn connect_inner(&self, id: Uuid, reconnect: bool) -> Result<Thread, ThreadError> {
        let agents = self.agents.lock().map_err(|_| unavailable())?;
        let mut state = self.lock()?;
        if state.closed {
            return Err(unavailable());
        }
        let agent_id = state
            .entries
            .get(&id)
            .ok_or_else(not_found)?
            .state
            .lock()
            .map_err(|_| unavailable())?
            .thread
            .agent_id
            .clone();
        if state
            .agent_transitions
            .get(&agent_id)
            .is_some_and(|transition| transition.draining)
        {
            return Err(unavailable());
        }
        let entry = state.entries.get_mut(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        let mut thread = current.thread.clone();
        if reconnect
            && matches!(
                thread.status,
                ThreadStatus::Running | ThreadStatus::WaitingForApproval | ThreadStatus::Cancelling
            )
        {
            return Err(ThreadError::NotReady(
                "작업이 진행 중입니다. 완료된 뒤 다시 시도해주세요.".into(),
            ));
        }
        if thread.status == ThreadStatus::Connecting
            || (!reconnect
                && matches!(
                    thread.status,
                    ThreadStatus::SessionReady
                        | ThreadStatus::Running
                        | ThreadStatus::WaitingForApproval
                        | ThreadStatus::Cancelling
                ))
        {
            return Ok(thread);
        }
        if !thread.working_folder.is_dir() {
            return Err(ThreadError::InvalidWorkingFolder(
                "작업 폴더를 찾을 수 없습니다. 폴더를 다시 선택해주세요.".into(),
            ));
        }
        let Some(agent) = agents
            .iter()
            .find(|agent| agent.id == thread.agent_id)
            .cloned()
        else {
            if current.thread.status != ThreadStatus::Failed
                || current.thread.failure != Some(ConnectionFailure::AgentRemoved)
            {
                current.thread.status = ThreadStatus::Failed;
                current.thread.failure = Some(ConnectionFailure::AgentRemoved);
                current.publish();
            }
            return Err(ThreadError::NotReady(
                "에이전트를 설치한 뒤 다시 시도해주세요.".into(),
            ));
        };
        let handle = tokio::runtime::Handle::try_current().map_err(|_| unavailable())?;
        let recreate = thread.status == ThreadStatus::Failed && thread.last_prompt_at.is_none();
        if recreate {
            thread.session_id = None;
        }
        thread.status = ThreadStatus::Connecting;
        thread.authentication = AuthenticationStatus::Unknown;
        thread.failure = None;
        thread.configuration.clear();
        if recreate {
            if let Some(store) = &current.store {
                store
                    .save_thread(&thread.metadata())
                    .map_err(|error| ThreadError::Unavailable(error.to_string()))?;
            }
        }
        current.generation += 1;
        current.thread = thread;
        current.clear_configuration();
        current.publish();
        let thread = current.thread.clone();
        let updates = RuntimeUpdates {
            authentication: self.authentication.clone(),
            state: entry.state.clone(),
            generation: current.generation,
        };
        let (prompts, requests) = mpsc::unbounded_channel();
        let (cancellations, cancelled) = mpsc::unbounded_channel();
        let (configuration, configuration_requests) = mpsc::unbounded_channel();
        let folder = thread.working_folder.clone();
        drop(current);
        let session = crate::agent_runtime::Session {
            id,
            remote_session: thread.session_id.clone(),
            updates,
            prompts: requests,
            cancellations: cancelled,
            configuration: configuration_requests,
        };
        let runtime = runtime_for(
            &mut state,
            &handle,
            agent,
            folder,
            self.authentication.clone(),
            self.authentication_observations.clone(),
        );
        state.entries.get_mut(&id).ok_or_else(not_found)?.runtime = Some(SessionCommands {
            inputs: crate::agent_runtime::SessionInputSenders {
                prompts,
                cancellations,
                configuration,
            },
            runtime: runtime.clone(),
        });
        if let Err(error) =
            runtime.send(crate::agent_runtime::RuntimeCommand::StartSession(session))
        {
            let crate::agent_runtime::RuntimeCommand::StartSession(session) = error.0 else {
                return Err(unavailable());
            };
            session.updates.modify(|thread| {
                thread.status = ThreadStatus::Failed;
                thread.failure = Some(ConnectionFailure::ConnectionClosed);
            });
            return Err(unavailable());
        }
        Ok(thread)
    }

    /// Atomically subscribes to a thread and every subsequent update.
    /// Dropping the receiver does not stop the thread.
    pub fn subscribe(
        &self,
        id: Uuid,
    ) -> Result<mpsc::UnboundedReceiver<ThreadUpdate>, ThreadError> {
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        current.cleanup_orphan_media();
        let (sender, receiver) = mpsc::unbounded_channel();
        let _ = sender.send(ThreadUpdate::Thread {
            thread: Box::new(current.thread.clone()),
        });
        current
            .subscribers
            .retain(|subscriber| !subscriber.is_closed());
        current.subscribers.push(sender);
        Ok(receiver)
    }

    /// Sends while ready, or queues input behind an active turn.
    ///
    /// # Errors
    ///
    /// Returns the same validation, readiness, persistence, and runtime errors as the underlying
    /// user-input operation.
    pub fn send_message(&self, id: Uuid, text: String) -> Result<(), ThreadError> {
        self.send_input(id, UserInput::text(text))
    }

    /// Sends one user input while ready, or queues it behind an active turn.
    ///
    /// # Errors
    ///
    /// Returns an error when the input is empty, the thread is unavailable or not ready, durable
    /// queue storage fails, or the connected runtime can no longer accept prompts.
    pub fn send_input(&self, id: Uuid, input: UserInput) -> Result<(), ThreadError> {
        if input.body.trim().is_empty() && input.attachments.is_empty() {
            return Err(ThreadError::InvalidMessage("메시지를 입력해주세요.".into()));
        }
        let state = self.lock()?;
        if state.closed {
            return Err(unavailable());
        }
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        if input
            .attachments
            .iter()
            .any(|attachment| match attachment.kind {
                AttachmentKind::File => false,
                AttachmentKind::Image => !current.thread.prompt_capabilities.image,
                AttachmentKind::Audio => !current.thread.prompt_capabilities.audio,
            })
        {
            return Err(ThreadError::InvalidMessage(
                "에이전트가 이 미디어 첨부를 지원하지 않습니다.".into(),
            ));
        }
        if state
            .agent_transitions
            .get(&current.thread.agent_id)
            .is_some_and(|transition| transition.draining)
            || current.dispatch_queue_on_ready
            || current
                .thread
                .queued_messages
                .first()
                .is_some_and(|queued| queued.status == QueuedMessageStatus::Failed)
            || matches!(
                current.thread.status,
                ThreadStatus::Running | ThreadStatus::WaitingForApproval | ThreadStatus::Cancelling
            )
        {
            current.enqueue(input)?;
            return Ok(());
        }
        if current.thread.status != ThreadStatus::SessionReady {
            return Err(ThreadError::NotReady(
                "응답이 완료된 연결된 스레드에서 전송해주세요.".into(),
            ));
        }
        let runtime = entry.runtime.as_ref().ok_or_else(unavailable)?;
        current.record_prompt_attempt()?;
        let turn = Uuid::new_v4();
        let durable_media = input
            .attachments
            .iter()
            .any(|attachment| attachment.kind != AttachmentKind::File)
            .then(|| QueuedMessage {
                id: Uuid::new_v4(),
                input: input.clone(),
                status: QueuedMessageStatus::Pending,
            });
        if let Some(pending) = &durable_media {
            current.dispatching_queued = Some(pending.clone());
            let queue = current.thread.queued_messages.clone();
            if let Err(error) = current.save_queue(queue) {
                current.dispatching_queued = None;
                return Err(error);
            }
        }
        if runtime
            .inputs
            .prompts
            .send(Prompt {
                turn,
                input: input.clone(),
                queued_message: durable_media.as_ref().map(|pending| pending.id),
            })
            .is_err()
        {
            current.dispatching_queued = None;
            let queue = current.thread.queued_messages.clone();
            current.save_queue(queue)?;
            current.thread.request_failure = Some(ConnectionFailure::PromptFailed);
            current.publish();
            return Err(unavailable());
        }
        current.thread.status = ThreadStatus::Running;
        current.thread.failure = None;
        current.thread.request_failure = None;
        current.thread.interrupted = false;
        if current.use_prompt_title {
            current.use_prompt_title = false;
            current.thread.title = input.body.trim().chars().take(60).collect::<String>();
            if current.thread.title.is_empty() {
                current.thread.title = input
                    .attachments
                    .first()
                    .map(|attachment| attachment.name.chars().take(60).collect())
                    .unwrap_or_default();
            }
        }
        current.thread.turns.push(Turn {
            id: turn,
            message: input.body,
            attachments: input.attachments,
            response: String::new(),
            stop_reason: None,
        });
        current.publish();
        Ok(())
    }

    /// Applies one typed, opaque ACP configuration value to the connected session.
    ///
    /// # Errors
    ///
    /// Returns an error when the thread or configuration value does not exist, the thread is not
    /// connected, the current runtime becomes unavailable, or the agent rejects the requested
    /// value. A completion dropped by an obsolete runtime generation is ignored.
    pub async fn set_configuration(
        &self,
        id: Uuid,
        config_id: String,
        value: ThreadConfigurationValue,
    ) -> Result<(), ThreadError> {
        let (response, generation) = {
            let state = self.lock()?;
            if state.closed {
                return Err(unavailable());
            }
            let entry = state.entries.get(&id).ok_or_else(not_found)?;
            let mut current = entry.state.lock().map_err(|_| unavailable())?;
            if !matches!(
                current.thread.status,
                ThreadStatus::SessionReady
                    | ThreadStatus::Running
                    | ThreadStatus::WaitingForApproval
                    | ThreadStatus::Cancelling
            ) {
                return Err(ThreadError::NotReady(
                    "연결된 스레드에서 설정을 변경해주세요.".into(),
                ));
            }
            let configuration_requests = entry
                .runtime
                .as_ref()
                .ok_or_else(unavailable)?
                .inputs
                .configuration
                .clone();
            let configuration = current
                .thread
                .configuration
                .iter_mut()
                .find(|configuration| configuration.id == config_id)
                .ok_or_else(|| ThreadError::NotReady("사용할 수 없는 스레드 설정입니다.".into()))?;
            if configuration.has_value(&value) {
                return Ok(());
            }
            if !configuration.accepts(&value) {
                return Err(ThreadError::NotReady(
                    "사용할 수 없는 스레드 설정값입니다.".into(),
                ));
            }
            configuration.set_value(&value);
            let request_id = Uuid::new_v4();
            current.desired_configuration.insert(
                config_id.clone(),
                DesiredConfiguration {
                    request_id,
                    value: value.clone(),
                },
            );
            current.publish();
            let (complete, response) = oneshot::channel();
            let send = configuration_requests.send(ConfigurationChange {
                request_id,
                config_id,
                value,
                complete,
            });
            if send.is_err() {
                current
                    .desired_configuration
                    .retain(|_, desired| desired.request_id != request_id);
                current.reconcile_configuration();
                current.publish();
                return Err(unavailable());
            }
            (response, current.generation)
        };
        match response.await {
            Ok(result) => result,
            Err(_) => {
                let state = self.lock()?;
                let Some(entry) = state.entries.get(&id) else {
                    return Ok(());
                };
                let current = entry.state.lock().map_err(|_| unavailable())?;
                if current.generation == generation {
                    Err(unavailable())
                } else {
                    Ok(())
                }
            }
        }
    }

    /// Deletes queued input and resumes the following input when the failed head is removed.
    ///
    /// # Errors
    ///
    /// Returns an error when the thread or queued input does not exist, the input is already being
    /// dispatched, persistence fails, or resuming the queue cannot reconnect to the agent.
    pub fn delete_queued_message(&self, id: Uuid, message: Uuid) -> Result<(), ThreadError> {
        let mut reconnect = false;
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let prompts = entry
            .runtime
            .as_ref()
            .map(|runtime| runtime.inputs.prompts.clone());
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        if current
            .dispatching_queued
            .as_ref()
            .is_some_and(|queued| queued.id == message)
        {
            return Err(ThreadError::NotReady(
                "이미 에이전트에 전송 중인 메시지입니다.".into(),
            ));
        }
        let mut queue = current.thread.queued_messages.clone();
        let index = queue
            .iter()
            .position(|item| item.id == message)
            .ok_or_else(|| {
                ThreadError::NotReady("이미 전송되었거나 삭제된 메시지입니다.".into())
            })?;
        let resumes_queue = index == 0 && queue[index].status == QueuedMessageStatus::Failed;
        let removed = queue.remove(index);
        current.save_queue(queue)?;
        current.remove_unreferenced_media(&removed.input.attachments);
        let next = if resumes_queue {
            match current.thread.status {
                ThreadStatus::SessionReady => current.prepare_next_queued_prompt(),
                ThreadStatus::Disconnected | ThreadStatus::Failed => {
                    current.dispatch_queue_on_ready = true;
                    reconnect = true;
                    None
                }
                _ => None,
            }
        } else {
            None
        };
        current.publish();
        if let Some(next) = next {
            current.send_queued_prompt(prompts.as_ref(), next)?;
        }
        drop(current);
        drop(state);
        if reconnect {
            self.connect(id)?;
        }
        Ok(())
    }

    /// Retries the failed head without allowing later queued input to overtake it.
    ///
    /// # Errors
    ///
    /// Returns an error when the thread is missing, the selected input is not the failed head, the
    /// thread cannot dispatch or reconnect, persistence fails, or the runtime channel is closed.
    pub fn retry_queued_message(&self, id: Uuid, message: Uuid) -> Result<(), ThreadError> {
        let mut reconnect = false;
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let prompts = entry
            .runtime
            .as_ref()
            .map(|runtime| runtime.inputs.prompts.clone());
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        let mut queue = current.thread.queued_messages.clone();
        let Some(first) = queue.first_mut() else {
            return Err(ThreadError::NotReady(
                "이미 전송되었거나 삭제된 메시지입니다.".into(),
            ));
        };
        if first.id != message || first.status != QueuedMessageStatus::Failed {
            return Err(ThreadError::NotReady(
                "실패한 첫 번째 대기 메시지만 다시 시도할 수 있습니다.".into(),
            ));
        }
        let dispatch_now = match current.thread.status {
            ThreadStatus::SessionReady => true,
            ThreadStatus::Disconnected | ThreadStatus::Failed => false,
            _ => {
                return Err(ThreadError::NotReady(
                    "다시 시도할 수 없는 상태입니다.".into(),
                ))
            }
        };
        first.status = QueuedMessageStatus::Pending;
        current.save_queue(queue)?;
        let next = if dispatch_now {
            current.prepare_next_queued_prompt()
        } else {
            current.dispatch_queue_on_ready = true;
            reconnect = true;
            None
        };
        current.publish();
        if let Some(next) = next {
            current.send_queued_prompt(prompts.as_ref(), next)?;
        }
        drop(current);
        drop(state);
        if reconnect {
            if let Err(error) = self.connect(id) {
                if let Ok(state) = self.lock() {
                    if let Some(entry) = state.entries.get(&id) {
                        if let Ok(mut current) = entry.state.lock() {
                            let mut queue = current.thread.queued_messages.clone();
                            if let Some(first) = queue.first_mut().filter(|item| item.id == message)
                            {
                                first.status = QueuedMessageStatus::Failed;
                                let _ = current.save_queue(queue);
                                current.dispatch_queue_on_ready = false;
                                current.publish();
                            }
                        }
                    }
                }
                return Err(error);
            }
        }
        Ok(())
    }

    /// Cancels the named active turn without replacing its session or history.
    pub fn cancel_turn(&self, id: Uuid, turn: Uuid) -> Result<(), ThreadError> {
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        if current.thread.turns.last().map(|item| item.id) != Some(turn) {
            return Err(ThreadError::NotReady("이미 종료된 작업입니다.".into()));
        }
        if current.thread.status == ThreadStatus::Cancelling {
            return Ok(());
        }
        if !matches!(
            current.thread.status,
            ThreadStatus::Running | ThreadStatus::WaitingForApproval
        ) {
            return Err(ThreadError::NotReady("진행 중인 작업이 없습니다.".into()));
        }
        entry
            .runtime
            .as_ref()
            .ok_or_else(unavailable)?
            .inputs
            .cancellations
            .send(turn)
            .map_err(|_| unavailable())?;
        current.thread.status = ThreadStatus::Cancelling;
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
    ) -> Result<(), ThreadError> {
        let state = self.lock()?;
        let entry = state.entries.get(&id).ok_or_else(not_found)?;
        let mut current = entry.state.lock().map_err(|_| unavailable())?;
        if current.thread.status != ThreadStatus::WaitingForApproval
            || !current.thread.permissions.iter().any(|permission| {
                permission.id == request
                    && permission.options.iter().any(|choice| choice.id == option)
            })
        {
            return Err(ThreadError::NotReady(
                "이미 해소되었거나 유효하지 않은 승인 선택입니다.".into(),
            ));
        }
        let response = current
            .permissions
            .remove(&request)
            .ok_or_else(unavailable)?;
        let result = response.send(option).map_err(|_| unavailable());
        current
            .thread
            .permissions
            .retain(|permission| permission.id != request);
        if current.thread.permissions.is_empty() {
            current.thread.status = ThreadStatus::Running;
        }
        current.publish();
        result
    }

    /// Stops and reaps all owned processes before application exit.
    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        let _lifecycle = self.lifecycle.lock().await;
        {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            state.closed = true;
            for entry in state.entries.values() {
                if let Ok(mut current) = entry.state.lock() {
                    if matches!(
                        current.thread.status,
                        ThreadStatus::Running
                            | ThreadStatus::WaitingForApproval
                            | ThreadStatus::Cancelling
                    ) {
                        current.thread.interrupted = true;
                        current.thread.status = ThreadStatus::Cancelling;
                        current.clear_permissions();
                        if let (Some(runtime), Some(turn)) =
                            (&entry.runtime, current.thread.turns.last())
                        {
                            let _ = runtime.inputs.cancellations.send(turn.id);
                        }
                        current.publish();
                    }
                }
            }
        }
        let mut updates = self.subscribe_list().ok();
        // Keep polling ACP long enough for cancellation replies, but never depend
        // on an unresponsive agent to let the application quit.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            if let Some(updates) = &mut updates {
                while let Some(entries) = updates.recv().await {
                    if entries.iter().all(|entry| {
                        !matches!(
                            entry.status,
                            ThreadStatus::Running
                                | ThreadStatus::WaitingForApproval
                                | ThreadStatus::Cancelling
                        )
                    }) {
                        break;
                    }
                }
            }
        })
        .await;
        let runtimes = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            state.closed = true;
            for entry in state.entries.values_mut() {
                if let Ok(mut current) = entry.state.lock() {
                    current.thread.interrupted |= matches!(
                        current.thread.status,
                        ThreadStatus::Running
                            | ThreadStatus::WaitingForApproval
                            | ThreadStatus::Cancelling
                    );
                    if current.thread.status != ThreadStatus::Failed {
                        current.thread.status = ThreadStatus::Disconnected;
                    }
                    current.clear_permissions();
                    if let Some(turn) = current
                        .thread
                        .turns
                        .last_mut()
                        .filter(|turn| turn.stop_reason.is_none())
                    {
                        turn.stop_reason = Some("cancelled".into());
                    }
                    current.publish();
                    current.generation += 1;
                }
                entry.runtime = None;
            }
            std::mem::take(&mut state.runtimes)
        };
        let _ = self.stop_runtimes(runtimes).await;
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, ThreadError> {
        self.state.lock().map_err(|_| unavailable())
    }
}

async fn stop_runtimes(runtimes: Vec<Runtime>) -> Result<(), Vec<Runtime>> {
    let mut runtimes = runtimes;
    for runtime in &mut runtimes {
        if let Some(stop) = runtime.stop.take() {
            let _ = stop.send(());
        }
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut failed = Vec::new();
    for mut runtime in runtimes {
        if let Some(task) = runtime.task.as_mut() {
            match tokio::time::timeout_at(deadline, task).await {
                Ok(Ok(true)) => {
                    runtime.task = None;
                    continue;
                }
                Ok(_) => runtime.task = None,
                Err(_) => {}
            }
        }
        let pid = runtime.pid.load(Ordering::Acquire);
        if pid == 0 {
            if runtime.task.is_some() {
                failed.push(runtime);
            }
            continue;
        }
        if process_exists(pid) {
            let _ = tokio::task::spawn_blocking(move || {
                let mut group = crate::agent_runtime::ProcessGroup::new(Some(pid));
                let killed = group.kill();
                group.disarm();
                killed
            })
            .await;
            if let Some(task) = runtime.task.as_mut() {
                if tokio::time::timeout(std::time::Duration::from_secs(1), task)
                    .await
                    .is_ok_and(|result| result.is_ok_and(|reaped| reaped))
                {
                    runtime.task = None;
                    continue;
                }
            }
            if process_exists(pid) {
                failed.push(runtime);
            }
        }
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(failed)
    }
}

fn process_exists(pid: u32) -> bool {
    i32::try_from(pid)
        .is_ok_and(|pid| nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok())
}

fn unavailable() -> ThreadError {
    ThreadError::Unavailable("스레드 상태를 사용할 수 없습니다.".into())
}

fn not_found() -> ThreadError {
    ThreadError::NotFound("스레드를 찾을 수 없습니다.".into())
}

fn media_attachment_ids(attachments: &[Attachment]) -> impl Iterator<Item = Uuid> + '_ {
    attachments
        .iter()
        .filter(|attachment| attachment.kind != AttachmentKind::File)
        .map(|attachment| attachment.id)
}

/// One accepted user message and its streamed response.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: Uuid,
    pub message: String,
    pub attachments: Vec<Attachment>,
    pub response: String,
    pub stop_reason: Option<String>,
}

pub(crate) struct Prompt {
    pub turn: Uuid,
    pub input: UserInput,
    pub queued_message: Option<Uuid>,
}

pub(crate) struct ConfigurationChange {
    pub request_id: Uuid,
    pub config_id: String,
    pub value: ThreadConfigurationValue,
    pub complete: oneshot::Sender<Result<(), ThreadError>>,
}

struct ThreadState {
    list: Arc<Mutex<list::ThreadList>>,
    store: Option<Arc<Store>>,
    media_store: Option<Arc<MediaStore>>,
    thread: Thread,
    // Only a new draft may derive a provisional title from its first input.
    use_prompt_title: bool,
    confirmed_configuration: Vec<ThreadConfiguration>,
    desired_configuration: HashMap<String, DesiredConfiguration>,
    generation: u64,
    subscribers: Vec<mpsc::UnboundedSender<ThreadUpdate>>,
    permissions: HashMap<Uuid, oneshot::Sender<String>>,
    draining: bool,
    dispatch_queue_on_ready: bool,
    dispatching_queued: Option<QueuedMessage>,
    published_failure: Option<ConnectionFailure>,
    pending_errors: Vec<ThreadErrorNotification>,
    published_turn_count: usize,
    published_last_turn: Option<(Uuid, Option<String>)>,
}

#[derive(Clone)]
struct DesiredConfiguration {
    request_id: Uuid,
    value: ThreadConfigurationValue,
}

impl ThreadState {
    fn record_prompt_attempt(&mut self) -> Result<(), ThreadError> {
        let timestamp = next_prompt_at();
        if let Some(store) = &self.store {
            let mut metadata = self.thread.metadata();
            metadata.last_prompt_at = Some(timestamp);
            store
                .save_thread(&metadata)
                .map_err(|error| ThreadError::Unavailable(error.to_string()))?;
        }
        // A crash or transport error after this point cannot prove the input was not received.
        self.thread.last_prompt_at = Some(timestamp);
        Ok(())
    }

    fn report_notice(&mut self, message: String) {
        self.thread.notice = Some(message.clone());
        self.pending_errors.push(ThreadErrorNotification {
            id: Uuid::new_v4(),
            failure: None,
            message: Some(message),
        });
    }

    fn enqueue(&mut self, input: UserInput) -> Result<(), ThreadError> {
        let mut queue = self.thread.queued_messages.clone();
        queue.push(QueuedMessage {
            id: Uuid::new_v4(),
            input,
            status: QueuedMessageStatus::Pending,
        });
        self.save_queue(queue)?;
        self.publish();
        Ok(())
    }

    fn clear_configuration(&mut self) {
        self.thread.configuration.clear();
        self.confirmed_configuration.clear();
        self.desired_configuration.clear();
        self.thread.prompt_capabilities = PromptCapabilities::default();
    }

    fn reconcile_configuration(&mut self) {
        self.desired_configuration.retain(|id, desired| {
            self.confirmed_configuration
                .iter()
                .find(|configuration| configuration.id == *id)
                .is_some_and(|configuration| configuration.accepts(&desired.value))
        });
        self.thread
            .configuration
            .clone_from(&self.confirmed_configuration);
        for (id, desired) in &self.desired_configuration {
            if let Some(configuration) = self
                .thread
                .configuration
                .iter_mut()
                .find(|configuration| configuration.id == *id)
            {
                configuration.set_value(&desired.value);
            }
        }
    }

    fn reconcile_queued_media(&mut self) -> Result<bool, ThreadError> {
        let capabilities = &self.thread.prompt_capabilities;
        let supported = |attachment: &Attachment| match attachment.kind {
            AttachmentKind::File => true,
            AttachmentKind::Image => capabilities.image,
            AttachmentKind::Audio => capabilities.audio,
        };
        let mut queue = self.thread.queued_messages.clone();
        let mut removed = Vec::new();
        for queued in &mut queue {
            let original_count = queued.input.attachments.len();
            queued.input.attachments.retain(|attachment| {
                if !supported(attachment) {
                    removed.push(attachment.clone());
                    return false;
                }
                true
            });
            if queued.input.attachments.len() != original_count
                && queued.status == QueuedMessageStatus::Failed
            {
                queued.status = QueuedMessageStatus::Pending;
            }
        }
        queue.retain(|queued| {
            !queued.input.body.trim().is_empty() || !queued.input.attachments.is_empty()
        });
        if queue == self.thread.queued_messages {
            return Ok(false);
        }
        let resume_queue = queue.first() != self.thread.queued_messages.first();
        self.save_queue(queue)?;
        self.remove_unreferenced_media(&removed);
        Ok(resume_queue)
    }

    fn save_queue(&mut self, queue: Vec<QueuedMessage>) -> Result<(), ThreadError> {
        if let Some(store) = &self.store {
            let mut durable = queue.clone();
            if let Some(dispatching) = &self.dispatching_queued {
                if !durable.iter().any(|queued| queued.id == dispatching.id) {
                    durable.insert(0, dispatching.clone());
                }
            }
            store
                .save_queue(self.thread.id, &durable)
                .map_err(|error| ThreadError::Unavailable(error.to_string()))?;
        }
        self.thread.queued_messages = queue;
        Ok(())
    }

    fn cleanup_orphan_media(&self) {
        let Some(store) = &self.media_store else {
            return;
        };
        store.cleanup_orphans(
            self.thread.id,
            self.thread
                .queued_messages
                .iter()
                .flat_map(|queued| media_attachment_ids(&queued.input.attachments))
                .chain(
                    self.dispatching_queued
                        .iter()
                        .flat_map(|queued| media_attachment_ids(&queued.input.attachments)),
                ),
        );
    }

    fn remove_unreferenced_media(&self, attachments: &[Attachment]) {
        let Some(store) = &self.media_store else {
            return;
        };
        let referenced = self
            .thread
            .queued_messages
            .iter()
            .flat_map(|queued| media_attachment_ids(&queued.input.attachments))
            .collect::<HashSet<_>>();
        store.remove(
            self.thread.id,
            media_attachment_ids(attachments).filter(|id| !referenced.contains(id)),
        );
    }

    fn clear_permissions(&mut self) {
        // Dropped senders resolve every pending ACP request as cancelled.
        self.permissions.clear();
        self.thread.permissions.clear();
    }

    fn prepare_next_queued_prompt(&mut self) -> Option<Prompt> {
        if self.dispatching_queued.is_some() {
            return None;
        }
        let queued = self.thread.queued_messages.first()?;
        if queued.status == QueuedMessageStatus::Failed {
            return None;
        }
        let queued = queued.clone();
        if let Err(error) = self.record_prompt_attempt() {
            let mut queue = self.thread.queued_messages.clone();
            queue[0].status = QueuedMessageStatus::Failed;
            if let Err(storage_error) = self.save_queue(queue) {
                self.report_notice(storage_error.to_string());
            }
            self.report_notice(error.to_string());
            return None;
        }
        let turn = Uuid::new_v4();
        self.dispatching_queued = Some(queued.clone());
        self.thread.status = ThreadStatus::Running;
        self.thread.request_failure = None;
        self.thread.turns.push(Turn {
            id: turn,
            message: queued.input.body.clone(),
            attachments: queued.input.attachments.clone(),
            response: String::new(),
            stop_reason: None,
        });
        Some(Prompt {
            turn,
            input: queued.input,
            queued_message: Some(queued.id),
        })
    }

    fn fail_queued_prompt(&mut self, turn: Uuid) {
        let Some(mut failed) = self.dispatching_queued.take() else {
            return;
        };
        failed.status = QueuedMessageStatus::Failed;
        let mut queue = self.thread.queued_messages.clone();
        if let Some(queued) = queue.iter_mut().find(|queued| queued.id == failed.id) {
            *queued = failed;
        } else {
            queue.insert(0, failed);
        }
        if let Err(error) = self.save_queue(queue) {
            self.report_notice(error.to_string());
        }
        if self
            .thread
            .turns
            .last()
            .is_some_and(|active| active.id == turn)
        {
            self.thread.turns.pop();
        }
        self.thread.status = ThreadStatus::SessionReady;
    }

    fn send_queued_prompt(
        &mut self,
        prompts: Option<&mpsc::UnboundedSender<Prompt>>,
        prompt: Prompt,
    ) -> Result<(), ThreadError> {
        let turn = prompt.turn;
        let Some(prompts) = prompts else {
            self.fail_queued_prompt(turn);
            self.thread.request_failure = Some(ConnectionFailure::PromptFailed);
            self.publish();
            return Err(unavailable());
        };
        if prompts.send(prompt).is_err() {
            self.fail_queued_prompt(turn);
            self.thread.request_failure = Some(ConnectionFailure::PromptFailed);
            self.publish();
            return Err(unavailable());
        }
        Ok(())
    }

    fn turn_updates(&mut self) -> Vec<TurnUpdate> {
        let turns = &self.thread.turns;
        let can_append = self.published_turn_count <= turns.len()
            && (self.published_turn_count == 0
                || turns
                    .get(self.published_turn_count - 1)
                    .is_some_and(|turn| {
                        self.published_last_turn
                            .as_ref()
                            .is_some_and(|(id, _)| *id == turn.id)
                    }));
        let mut updates = if can_append {
            Vec::new()
        } else {
            vec![TurnUpdate::Replaced {
                turns: turns.clone(),
            }]
        };
        if can_append {
            if let (Some((turn_id, stop_reason)), Some(turn)) = (
                self.published_last_turn.as_ref(),
                self.published_turn_count
                    .checked_sub(1)
                    .and_then(|index| turns.get(index)),
            ) {
                if turn.stop_reason != *stop_reason {
                    updates.push(TurnUpdate::Completed {
                        turn_id: *turn_id,
                        stop_reason: turn.stop_reason.clone(),
                    });
                }
            }
            updates.extend(
                turns[self.published_turn_count..]
                    .iter()
                    .cloned()
                    .map(|turn| TurnUpdate::Added { turn }),
            );
        }
        self.published_turn_count = turns.len();
        self.published_last_turn = turns.last().map(|turn| (turn.id, turn.stop_reason.clone()));
        updates
    }

    fn publish(&mut self) {
        self.thread.updated_at = now();
        let previous_storage_error = self.thread.storage_error.clone();
        if let Some(store) = &self.store {
            self.thread.storage_error = store
                .save_thread(&self.thread.metadata())
                .err()
                .map(|error| error.to_string());
        }
        if self.thread.failure != self.published_failure {
            if let Some(failure) = &self.thread.failure {
                self.pending_errors.push(ThreadErrorNotification {
                    id: Uuid::new_v4(),
                    failure: Some(failure.clone()),
                    message: None,
                });
            }
            self.published_failure = self.thread.failure.clone();
        }
        if self.thread.storage_error != previous_storage_error {
            if let Some(message) = &self.thread.storage_error {
                self.pending_errors.push(ThreadErrorNotification {
                    id: Uuid::new_v4(),
                    failure: None,
                    message: Some(message.clone()),
                });
            }
        }
        if let Ok(mut list) = self.list.lock() {
            list.publish(self.thread.metadata());
        }
        let turns = self.turn_updates();
        let change = ThreadUpdate::Patch {
            thread: Box::new(ThreadPatch::from(&self.thread)),
            turn_updates: turns,
            errors: std::mem::take(&mut self.pending_errors),
        };
        self.subscribers
            .retain(|sender| sender.send(change.clone()).is_ok());
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn next_prompt_at() -> u64 {
    let wall_clock = now_millis();
    let previous = LAST_PROMPT_AT
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |previous| {
            Some(wall_clock.max(previous.saturating_add(1)))
        })
        .unwrap_or_else(|previous| previous);
    wall_clock.max(previous.saturating_add(1))
}

/// Ordered subscription item. Only the initial snapshot carries the full transcript.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ThreadUpdate {
    Thread {
        thread: Box<Thread>,
    },
    Patch {
        thread: Box<ThreadPatch>,
        #[serde(rename = "turnUpdates")]
        turn_updates: Vec<TurnUpdate>,
        errors: Vec<ThreadErrorNotification>,
    },
    TextDelta {
        #[serde(rename = "threadId")]
        thread_id: Uuid,
        #[serde(rename = "turnId")]
        turn_id: Uuid,
        text: String,
    },
}

/// A transient failure occurrence, delivered only with live updates, never snapshots.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadErrorNotification {
    pub id: Uuid,
    pub failure: Option<ConnectionFailure>,
    pub message: Option<String>,
}

/// A transcript mutation carried with a lightweight thread patch.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TurnUpdate {
    Added {
        turn: Turn,
    },
    Completed {
        #[serde(rename = "turnId")]
        turn_id: Uuid,
        #[serde(rename = "stopReason")]
        stop_reason: Option<String>,
    },
    Replaced {
        turns: Vec<Turn>,
    },
}

/// A connection-scoped writer. Retired runtimes cannot overwrite a replacement.
#[derive(Clone)]
pub(crate) struct RuntimeUpdates {
    authentication: Arc<Mutex<HashMap<String, AuthenticationStatus>>>,
    state: Arc<Mutex<ThreadState>>,
    generation: u64,
}

impl RuntimeUpdates {
    pub fn title_updated(&self, title: Option<String>) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.generation != self.generation {
            return;
        }
        state.use_prompt_title = false;
        let title = title.unwrap_or_default();
        if state.thread.title == title {
            return;
        }
        state.thread.title = title;
        state.publish();
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn is_current(&self) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.generation == self.generation)
    }

    pub fn media_bytes(&self, attachment: Uuid) -> Result<Vec<u8>, ThreadError> {
        let state = self.state.lock().map_err(|_| unavailable())?;
        if state.generation != self.generation {
            return Err(unavailable());
        }
        state
            .media_store
            .as_ref()
            .ok_or_else(unavailable)?
            .read(state.thread.id, attachment)
    }

    pub fn direct_prompt_failed(&self, turn: Uuid, input: UserInput) {
        if !input
            .attachments
            .iter()
            .any(|attachment| attachment.kind != AttachmentKind::File)
        {
            return;
        }
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.generation != self.generation
            || state.thread.turns.last().map(|active| active.id) != Some(turn)
        {
            return;
        }
        let mut queue = state.thread.queued_messages.clone();
        queue.insert(
            0,
            QueuedMessage {
                id: Uuid::new_v4(),
                input,
                status: QueuedMessageStatus::Failed,
            },
        );
        if let Err(error) = state.save_queue(queue) {
            state.report_notice(error.to_string());
        }
        state.thread.turns.pop();
        state.publish();
    }

    pub fn session_ready(
        &self,
        session_id: String,
        configuration: Vec<ThreadConfiguration>,
        prompt_capabilities: PromptCapabilities,
    ) -> Option<Prompt> {
        let mut state = self.state.lock().ok()?;
        if state.generation != self.generation {
            return None;
        }
        state.thread.session_id = Some(session_id);
        state.thread.status = ThreadStatus::SessionReady;
        state.thread.failure = None;
        state.thread.request_failure = None;
        state.confirmed_configuration = configuration;
        state.thread.prompt_capabilities = prompt_capabilities;
        state.desired_configuration.clear();
        state.reconcile_configuration();
        let next = match state.reconcile_queued_media() {
            Ok(resume_queue) => {
                let next = (state.dispatch_queue_on_ready || resume_queue)
                    .then(|| state.prepare_next_queued_prompt())
                    .flatten();
                state.dispatch_queue_on_ready = false;
                next
            }
            Err(error) => {
                state.report_notice(error.to_string());
                None
            }
        };
        state.publish();
        next
    }

    pub fn configuration_updated(&self, configuration: Vec<ThreadConfiguration>) {
        self.modify_state(|state| {
            state.confirmed_configuration = configuration;
            state.reconcile_configuration();
        });
    }

    pub fn prepare_configuration_change(
        &self,
        request_id: Uuid,
        config_id: &str,
        value: &ThreadConfigurationValue,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.generation != self.generation {
            return false;
        }
        let is_current = state
            .desired_configuration
            .get(config_id)
            .is_some_and(|desired| desired.request_id == request_id);
        let should_send = is_current
            && state
                .confirmed_configuration
                .iter()
                .find(|configuration| configuration.id == config_id)
                .is_some_and(|configuration| {
                    configuration.accepts(value) && !configuration.has_value(value)
                });
        if is_current && !should_send {
            state.desired_configuration.remove(config_id);
            state.reconcile_configuration();
            state.publish();
        }
        should_send
    }

    pub fn configuration_failed(&self, request_id: Uuid, config_id: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.generation != self.generation {
            return false;
        }
        if state
            .desired_configuration
            .get(config_id)
            .is_some_and(|desired| desired.request_id == request_id)
        {
            state.desired_configuration.remove(config_id);
        }
        state.reconcile_configuration();
        state.publish();
        true
    }

    pub fn configuration_succeeded(
        &self,
        request_id: Uuid,
        config_id: &str,
        configuration: Vec<ThreadConfiguration>,
    ) {
        self.modify_state(|state| {
            state.confirmed_configuration = configuration;
            if state
                .desired_configuration
                .get(config_id)
                .is_some_and(|desired| desired.request_id == request_id)
            {
                state.desired_configuration.remove(config_id);
            }
            state.reconcile_configuration();
        });
    }

    pub fn history_restored(&self, turns: Vec<Turn>) {
        self.modify_state(|state| {
            state.thread.turns = turns;
            state.thread.notice = None;
            state.published_turn_count = usize::MAX;
            state.published_last_turn = None;
        });
    }

    pub fn context_resumed(&self) {
        self.modify(|thread| {
            thread.notice = Some(
                "기존 맥락을 재개했습니다. 이 에이전트는 이전 메시지 표시를 지원하지 않습니다."
                    .into(),
            );
        });
    }

    pub fn connection_failed(&self, failure: ConnectionFailure) {
        if failure == ConnectionFailure::AuthenticationRequired {
            self.record_authentication(AuthenticationStatus::Required);
        }
        self.modify_state(|state| {
            if state.dispatching_queued.is_some() {
                let turn = state.thread.turns.last().map(|turn| turn.id);
                state.fail_queued_prompt(turn.unwrap_or_default());
            }
            state.thread.interrupted |= matches!(
                state.thread.status,
                ThreadStatus::Running | ThreadStatus::WaitingForApproval | ThreadStatus::Cancelling
            );
            state.thread.status = ThreadStatus::Failed;
            state.clear_configuration();
            if failure == ConnectionFailure::AuthenticationRequired {
                state.thread.authentication = AuthenticationStatus::Required;
            }
            if failure == ConnectionFailure::PromptFailed {
                state.thread.request_failure = Some(failure.clone());
            }
            state.thread.failure = Some(failure);
        });
    }

    pub fn connection_closed(&self) {
        self.modify_state(|state| {
            if state.dispatching_queued.is_some() {
                let turn = state.thread.turns.last().map(|turn| turn.id);
                state.fail_queued_prompt(turn.unwrap_or_default());
            }
            state.thread.interrupted |= matches!(
                state.thread.status,
                ThreadStatus::Running | ThreadStatus::WaitingForApproval | ThreadStatus::Cancelling
            );
            state.thread.status = ThreadStatus::Disconnected;
            state.clear_configuration();
        });
    }

    pub fn complete_turn(
        &self,
        turn: Uuid,
        reason: agent_client_protocol::schema::v1::StopReason,
    ) -> Option<Prompt> {
        self.record_authentication(AuthenticationStatus::Authenticated);
        let mut state = self.state.lock().ok()?;
        if state.generation != self.generation
            || !matches!(
                state.thread.status,
                ThreadStatus::Running | ThreadStatus::WaitingForApproval | ThreadStatus::Cancelling
            )
            || state.thread.turns.last().map(|item| item.id) != Some(turn)
        {
            return None;
        }
        let cancelled = state.thread.status == ThreadStatus::Cancelling;
        state.thread.interrupted =
            cancelled || reason == agent_client_protocol::schema::v1::StopReason::Cancelled;
        if !state.thread.interrupted {
            state.thread.completed_turn_id = Some(turn);
        }
        if let Some(turn) = state.thread.turns.last_mut() {
            turn.stop_reason = serde_json::to_value(if cancelled {
                agent_client_protocol::schema::v1::StopReason::Cancelled
            } else {
                reason
            })
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned));
        }
        if let Some(queued_message) = state.dispatching_queued.take() {
            let completed_attachments = queued_message.input.attachments.clone();
            let mut queue = state.thread.queued_messages.clone();
            if let Some(index) = queue
                .iter()
                .position(|queued| queued.id == queued_message.id)
            {
                queue.remove(index);
            }
            if let Err(error) = state.save_queue(queue) {
                state.report_notice(error.to_string());
                state.thread.status = ThreadStatus::SessionReady;
                state.publish();
                return None;
            }
            state.remove_unreferenced_media(&completed_attachments);
        } else if let Some(completed) = state.thread.turns.last() {
            state.remove_unreferenced_media(&completed.attachments);
        }
        state.thread.status = ThreadStatus::SessionReady;
        state.thread.authentication = AuthenticationStatus::Authenticated;
        state.clear_permissions();
        let next = if !state.draining
            && !cancelled
            && reason == agent_client_protocol::schema::v1::StopReason::EndTurn
        {
            state.prepare_next_queued_prompt()
        } else {
            None
        };
        state.publish();
        next
    }

    /// Removes a queued input once ACP has recorded its prompt request.
    pub fn queued_prompt_dispatched(&self, queued_message: Uuid) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.generation != self.generation
            || !state
                .dispatching_queued
                .as_ref()
                .is_some_and(|queued| queued.id == queued_message)
        {
            return;
        }
        let mut queue = state.thread.queued_messages.clone();
        if let Some(index) = queue.iter().position(|queued| queued.id == queued_message) {
            queue.remove(index);
        }
        if let Err(error) = state.save_queue(queue) {
            state.report_notice(error.to_string());
        }
        state.publish();
    }

    /// Restores a failed queued prompt without terminating an otherwise healthy session.
    pub fn queued_prompt_failed(
        &self,
        turn: Uuid,
        queued_message: Uuid,
        failure: ConnectionFailure,
    ) {
        if failure == ConnectionFailure::AuthenticationRequired {
            self.record_authentication(AuthenticationStatus::Required);
        }
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.generation != self.generation {
            return;
        }
        if !state
            .dispatching_queued
            .as_ref()
            .is_some_and(|queued| queued.id == queued_message)
        {
            return;
        }
        state.fail_queued_prompt(turn);
        state.thread.request_failure = Some(failure.clone());
        if failure != ConnectionFailure::AuthenticationRequired {
            state.pending_errors.push(ThreadErrorNotification {
                id: Uuid::new_v4(),
                failure: Some(failure.clone()),
                message: None,
            });
        }
        if failure == ConnectionFailure::AuthenticationRequired {
            state.thread.authentication = AuthenticationStatus::Required;
            state.thread.status = ThreadStatus::Failed;
            state.thread.failure = Some(failure);
            state.clear_configuration();
        }
        state.publish();
    }

    pub fn request_permission(
        &self,
        turn: Uuid,
        request: PermissionRequest,
    ) -> Option<oneshot::Receiver<String>> {
        let mut state = self.state.lock().ok()?;
        if state.generation != self.generation
            || !matches!(
                state.thread.status,
                ThreadStatus::Running | ThreadStatus::WaitingForApproval
            )
            || state.thread.turns.last().map(|item| item.id) != Some(turn)
        {
            return None;
        }
        let (sender, receiver) = oneshot::channel();
        state.permissions.insert(request.id, sender);
        state.thread.permissions.push(request);
        state.thread.status = ThreadStatus::WaitingForApproval;
        state.publish();
        Some(receiver)
    }

    fn record_authentication(&self, status: AuthenticationStatus) {
        let Ok(state) = self.state.lock() else {
            return;
        };
        if state.generation != self.generation {
            return;
        }
        if let Ok(mut authentication) = self.authentication.lock() {
            authentication.insert(state.thread.agent_id.clone(), status);
        }
    }

    pub fn append_text(&self, turn: Uuid, text: String) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.generation != self.generation
            || !matches!(
                state.thread.status,
                ThreadStatus::Running | ThreadStatus::WaitingForApproval
            )
            || state.thread.turns.last().map(|item| item.id) != Some(turn)
        {
            return;
        }
        if let Some(last) = state.thread.turns.last_mut() {
            last.response.push_str(&text);
        }
        let change = ThreadUpdate::TextDelta {
            thread_id: state.thread.id,
            turn_id: turn,
            text,
        };
        state
            .subscribers
            .retain(|sender| sender.send(change.clone()).is_ok());
    }

    fn modify(&self, update: impl FnOnce(&mut Thread)) {
        self.modify_state(|state| update(&mut state.thread));
    }

    fn modify_state(&self, update: impl FnOnce(&mut ThreadState)) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.generation != self.generation {
            return;
        }
        update(&mut state);
        if !matches!(
            state.thread.status,
            ThreadStatus::Running | ThreadStatus::WaitingForApproval
        ) {
            state.clear_permissions();
        }
        state.publish();
    }
}

#[cfg(test)]
mod title_tests {
    use super::*;

    fn updates_for(threads: &Threads, id: Uuid) -> RuntimeUpdates {
        let entries = threads.lock().unwrap();
        let state = entries.entries[&id].state.clone();
        let generation = state.lock().unwrap().generation;
        RuntimeUpdates {
            authentication: threads.authentication.clone(),
            state,
            generation,
        }
    }

    #[test]
    fn title_updates_preserve_state_and_skip_duplicate_publications() {
        let folder = tempfile::tempdir().unwrap();
        let threads = Threads::default();
        let draft = threads.create(folder.path()).unwrap();
        let other = threads.create(folder.path()).unwrap();
        let updates = updates_for(&threads, draft.id);
        let mut stream = threads.subscribe(draft.id).unwrap();
        let mut list = threads.subscribe_list().unwrap();
        stream.try_recv().unwrap();
        list.try_recv().unwrap();

        // An explicit title equal to the default still disables the provisional title.
        updates.title_updated(Some(draft.title.clone()));
        assert!(!updates.state.lock().unwrap().use_prompt_title);
        assert!(stream.try_recv().is_err());
        assert!(list.try_recv().is_err());

        for status in [
            ThreadStatus::SessionReady,
            ThreadStatus::Running,
            ThreadStatus::Cancelling,
        ] {
            updates.state.lock().unwrap().thread.status = status;
            let before = threads.get(draft.id).unwrap();
            updates.title_updated(Some(format!("Title for {:?}", before.status)));
            let changed = threads.get(draft.id).unwrap();
            assert_eq!(changed.status, before.status);
            assert_eq!(changed.last_prompt_at, before.last_prompt_at);
            assert_eq!(changed.turns, before.turns);
            assert_eq!(changed.queued_messages, before.queued_messages);
            stream.try_recv().unwrap();
            list.try_recv().unwrap();
            updates.title_updated(Some(changed.title.clone()));
            assert!(stream.try_recv().is_err());
            assert!(list.try_recv().is_err());
        }
        updates.title_updated(None);
        assert_eq!(threads.get(draft.id).unwrap().title, "");
        stream.try_recv().unwrap();
        list.try_recv().unwrap();
        updates.title_updated(Some(String::new()));
        assert!(stream.try_recv().is_err());
        assert!(list.try_recv().is_err());
        assert_eq!(threads.get(other.id).unwrap().title, other.title);
    }

    #[test]
    fn replaced_runtime_cannot_change_title_or_its_provisional_policy() {
        let folder = tempfile::tempdir().unwrap();
        let threads = Threads::default();
        let draft = threads.create(folder.path()).unwrap();
        let updates = updates_for(&threads, draft.id);
        updates.state.lock().unwrap().generation += 1;
        updates.title_updated(Some("Obsolete title".into()));
        updates.title_updated(None);
        assert_eq!(threads.get(draft.id).unwrap().title, draft.title);
        assert!(updates.state.lock().unwrap().use_prompt_title);
    }

    #[test]
    fn title_storage_failure_uses_the_existing_error_subscription() {
        let folder = tempfile::tempdir().unwrap();
        let database = folder.path().join("atte.sqlite");
        let store = Arc::new(Store::open(&database).unwrap());
        let threads = Threads::with_store(vec![prepared_codex()], store).unwrap();
        let draft = threads.create(folder.path()).unwrap();
        let updates = updates_for(&threads, draft.id);
        let mut stream = threads.subscribe(draft.id).unwrap();
        stream.try_recv().unwrap();
        rusqlite::Connection::open(database)
            .unwrap()
            .execute("DROP TABLE threads", [])
            .unwrap();

        updates.title_updated(Some("Visible despite storage failure".into()));
        let ThreadUpdate::Patch { thread, errors, .. } = stream.try_recv().unwrap() else {
            panic!("expected metadata patch");
        };
        assert_eq!(thread.metadata.title, "Visible despite storage failure");
        assert!(thread.storage_error.is_some());
        assert_eq!(errors.len(), 1);
        assert_eq!(threads.get(draft.id).unwrap().status, draft.status);
    }
}
