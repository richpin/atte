//! Shared ACP stdio connection with independent, session-scoped execution.
mod elicitation;
mod plan;
mod process;
mod replay;
use crate::{
    agent::AgentDefinition,
    agent_management::authentication::{
        supports_auth_status, AuthStatus, AuthStatusUpdate, AuthenticationObservation,
    },
    thread::{
        Attachment, AttachmentKind, ConfigurationChange, ConnectionFailure, PermissionOption,
        PermissionRequest, Prompt, RuntimeUpdates, ThreadConfiguration, ThreadConfigurationChoice,
        ThreadConfigurationControl, ThreadConfigurationGroup, ThreadConfigurationSelectOptions,
        ThreadConfigurationValue, ThreadError,
    },
};
use agent_client_protocol::{
    schema::{
        v1::{
            AgentCapabilities, AudioContent, BooleanConfigOptionCapabilities, CancelNotification,
            ClientCapabilities, ClientSessionCapabilities, ContentBlock, DeleteSessionRequest,
            ImageContent, InitializeRequest, LoadSessionRequest, Meta, NewSessionRequest,
            PlanCapabilities, PromptRequest, RequestPermissionOutcome, RequestPermissionRequest,
            RequestPermissionResponse, ResourceLink, ResumeSessionRequest,
            SelectedPermissionOutcome, SessionConfigKind, SessionConfigOption,
            SessionConfigOptionValue, SessionConfigOptionsCapabilities, SessionConfigSelectOption,
            SessionConfigSelectOptions, SessionId, SessionNotification, SessionUpdate,
            SetSessionConfigOptionRequest, ToolCallContent,
        },
        MaybeUndefined, ProtocolVersion,
    },
    Agent, ByteStreams, Client, ConnectionTo, ErrorCode,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
pub(crate) use process::ProcessGroup;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    process::Command,
    sync::{mpsc, oneshot},
};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use uuid::Uuid;

pub(crate) struct Session {
    pub id: Uuid,
    pub remote_session: Option<String>,
    pub initial_configuration: Vec<ThreadConfiguration>,
    pub updates: RuntimeUpdates,
    pub prompts: mpsc::UnboundedReceiver<Prompt>,
    pub cancellations: mpsc::UnboundedReceiver<Uuid>,
    pub configuration: mpsc::UnboundedReceiver<ConfigurationChange>,
}

pub(crate) struct SessionInputSenders {
    pub prompts: mpsc::UnboundedSender<Prompt>,
    pub cancellations: mpsc::UnboundedSender<Uuid>,
    pub configuration: mpsc::UnboundedSender<ConfigurationChange>,
}

pub(crate) enum RuntimeCommand {
    StartSession(Session),
    DeleteSession {
        owner: Uuid,
        session_id: String,
        inputs_to_close: Option<SessionInputSenders>,
    },
}

struct Route {
    owner: Uuid,
    updates: RuntimeUpdates,
    active: Option<ActiveTurn>,
    replay: Option<replay::Replay>,
}

type Routes = Arc<Mutex<HashMap<String, Route>>>;

pub(crate) async fn run(
    agent: AgentDefinition,
    folder: PathBuf,
    mut commands: mpsc::UnboundedReceiver<RuntimeCommand>,
    mut stop: oneshot::Receiver<()>,
    pid: Arc<AtomicU32>,
    authentication: Arc<Mutex<HashMap<String, crate::thread::AuthenticationStatus>>>,
    authentication_observations: Arc<Mutex<HashMap<String, AuthenticationObservation>>>,
) -> bool {
    let launch = tokio::select! {
        _ = &mut stop => return true,
        launch = crate::agent_management::node_runtime::resolve_launch(&agent) => launch,
    };
    let Ok(launch) = launch else {
        commands.close();
        while let Some(command) = commands.recv().await {
            if let RuntimeCommand::StartSession(session) = command {
                session
                    .updates
                    .connection_failed(ConnectionFailure::ExecutableNotFound);
            }
        }
        return true;
    };
    let mut command = Command::new(launch.program);
    command
        .args(launch.args)
        .envs(&agent.env)
        .current_dir(&folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(path) = launch.path {
        command.env("PATH", path);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            commands.close();
            while let Some(command) = commands.recv().await {
                match command {
                    RuntimeCommand::StartSession(session) => session.updates.connection_failed(
                        if error.kind() == std::io::ErrorKind::NotFound {
                            ConnectionFailure::ExecutableNotFound
                        } else {
                            ConnectionFailure::LaunchFailed
                        },
                    ),
                    RuntimeCommand::DeleteSession { .. } => {
                        eprintln!("ACP session deletion connection could not be launched");
                    }
                }
            }
            return true;
        }
    };
    let mut group = ProcessGroup::new(child.id());
    if let Some(id) = child.id() {
        pid.store(id, Ordering::Release);
    }
    let Some(stdin) = child.stdin.take() else {
        return false;
    };
    let Some(stdout) = child.stdout.take() else {
        return false;
    };
    let routes: Routes = Arc::default();
    let participants = Arc::new(Mutex::new(HashMap::<Uuid, RuntimeUpdates>::new()));
    let mut first_command = commands.recv().await;
    let initial_updates = match &first_command {
        Some(RuntimeCommand::StartSession(session)) => {
            if let Ok(mut all) = participants.lock() {
                all.insert(session.id, session.updates.clone());
            }
            Some(session.updates.clone())
        }
        _ => None,
    };
    let owners: elicitation::Owners = Arc::default();
    let form_owners = owners.clone();
    let form_routes = routes.clone();
    let permission_routes = routes.clone();
    let notification_routes = routes.clone();
    let auth_status_supported = Arc::new(AtomicBool::new(false));
    let pending_auth_status = Arc::new(Mutex::new(None::<AuthStatus>));
    let auth_status_enabled = auth_status_supported.clone();
    let auth_status_pending = pending_auth_status.clone();
    let auth_status_evidence = authentication.clone();
    let auth_status_observations = authentication_observations.clone();
    let auth_status_agent = agent.id.clone();
    let mut protocol = Box::pin(Client.builder()
        .on_receive_request(async move |request: RequestPermissionRequest, responder, cx| {
            let mut request_updates = None;
            let request_id = Uuid::new_v4();
            let decision = permission_routes.lock().ok().and_then(|mut routes| {
                let route = routes.get_mut(&request.session_id.to_string())?;
                request_updates = Some(route.updates.clone());
                let active = route.active.as_mut()?;
                let turn = active.turn;
                let tool_id = request.tool_call.tool_call_id.to_string();
                let fields = route.updates.update_tool(turn, request.tool_call)?;
                let details = [
                    fields.raw_input.as_ref().and_then(|value| serde_json::to_string_pretty(value).ok()),
                    fields.content.as_ref().and_then(|content| {
                        let visible: Vec<_> = content.iter().filter(|item| !matches!(item, ToolCallContent::Terminal(_))).collect();
                        (!visible.is_empty()).then(|| serde_json::to_string_pretty(&visible).ok()).flatten()
                    }),
                    fields.locations.as_ref().filter(|locations| !locations.is_empty()).and_then(|value| serde_json::to_string_pretty(value).ok()),
                ].into_iter().flatten().collect::<Vec<_>>().join("\n");
                route.updates.request_permission(turn, PermissionRequest {
                    plan_review: plan::plan_review(&tool_id, &fields, &request.options),
                    id: request_id, tool_call_id: tool_id.clone(), title: fields.title.clone().unwrap_or(tool_id), details,
                    options: request.options.into_iter().map(|option| PermissionOption { id: option.option_id.to_string(), name: option.name }).collect(),
                })
            });
            // Waiting for one user's decision must not block another session.
            let cancellation = responder.cancellation();
            cx.spawn(async move {
                let outcome = match decision {
                    Some(decision) => match tokio::select! { biased; _ = cancellation.cancelled() => None, result = decision => result.ok() } {
                        Some(option) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option)),
                        None => RequestPermissionOutcome::Cancelled,
                    },
                    None => RequestPermissionOutcome::Cancelled,
                };
                if let Some(updates) = request_updates { updates.interaction_finished(request_id); }
                responder.respond(RequestPermissionResponse::new(outcome))
            })
        }, agent_client_protocol::on_receive_request!())

        .on_receive_request(async move |request: agent_client_protocol::schema::v1::CreateElicitationRequest, responder, cx| {
            use agent_client_protocol::schema::v1::{ElicitationMode, ElicitationScope, ElicitationAction, CreateElicitationResponse};
            let ElicitationMode::Form(form) = request.mode else { return responder.respond_with_error(agent_client_protocol::Error::invalid_params()); };
            let owner = match &form.scope {
                ElicitationScope::Request(scope) => form_owners.lock().ok().and_then(|all| all.get(&scope.request_id).cloned()),
                ElicitationScope::Session(scope) => form_routes.lock().ok().and_then(|all| all.get(&scope.session_id.to_string()).map(|route| elicitation::Owner { updates: route.updates.clone(), operation: route.active.as_ref().map(|turn| turn.turn).unwrap_or_else(Uuid::nil) })),
                _ => None,
            };
            let Some(owner) = owner else { return responder.respond(CreateElicitationResponse::new(ElicitationAction::Cancel)); };
            let (schema, validator) = match crate::thread::interaction::prepare_form(&form.requested_schema) {
                Ok(prepared) => prepared,
                Err(error) => return responder.respond_with_error(agent_client_protocol::Error::invalid_params().data(error.to_string())),
            };
            let tool_call_id = match &form.scope { ElicitationScope::Session(scope) => scope.tool_call_id.as_ref().map(ToString::to_string), _ => None };
            let id = Uuid::new_v4();
            let operation = if owner.operation.is_nil() { form_owners.lock().ok().and_then(|all| all.values().find(|candidate| candidate.updates.thread_id() == owner.updates.thread_id()).map(|candidate| candidate.operation)) } else { Some(owner.operation) };
            let decision = owner.updates.request_form(crate::thread::FormRequest { id, message: request.message, tool_call_id, schema }, validator, operation);
            let cancellation = responder.cancellation();
            cx.spawn(async move {
                let answer = match decision { Some(decision) => tokio::select! { biased; _ = cancellation.cancelled() => None, answer = decision => answer.ok() }, None => None };
                owner.updates.interaction_finished(id);
                let wire = match answer.unwrap_or(crate::thread::ElicitationAnswer::Cancel) {
                    crate::thread::ElicitationAnswer::Accept { values } => serde_json::json!({"action":"accept", "content":values}),
                    crate::thread::ElicitationAnswer::Decline => serde_json::json!({"action":"decline"}),
                    crate::thread::ElicitationAnswer::Cancel => serde_json::json!({"action":"cancel"}),
                };
                let response = serde_json::from_value::<CreateElicitationResponse>(wire).map_err(|_| agent_client_protocol::Error::invalid_params())?;
                responder.respond(response)
            })
        }, agent_client_protocol::on_receive_request!())
        .on_receive_notification(async move |notification: SessionNotification, _cx| {
            if let Ok(mut routes) = notification_routes.lock() {
                if let Some(route) = routes.get_mut(&notification.session_id.to_string()) {
                    match notification.update {
                        SessionUpdate::SessionInfoUpdate(update) => match update.title {
                            MaybeUndefined::Value(title) => route.updates.title_updated(Some(title)),
                            MaybeUndefined::Null => route.updates.title_updated(None),
                            MaybeUndefined::Undefined => {},
                        },
                        SessionUpdate::AvailableCommandsUpdate(update) => route.updates.available_commands_updated(
                            update.available_commands.into_iter().map(|command| crate::thread::AvailableCommand {
                                name: command.name,
                                description: command.description,
                                input_hint: match command.input {
                                    Some(agent_client_protocol::schema::v1::AvailableCommandInput::Unstructured(input)) => Some(input.hint),
                                    _ => None,
                                },
                            }).collect()
                        ),
                        SessionUpdate::UsageUpdate(update) => route.updates.context_usage_updated(crate::thread::ContextUsage { used: update.used, size: update.size }),
                        SessionUpdate::ConfigOptionUpdate(update) => route
                            .updates
                            .configuration_updated(thread_configuration(update.config_options)),
                        update if route.replay.is_some() => {
                            if let Some(replay) = &mut route.replay {
                                replay.update(update);
                            }
                        }
                        SessionUpdate::PlanUpdate(update) => {
                            if let Some((plan_id, content)) = plan::plan_content(update) {
                                route.updates.update_plan_content(route.active.as_ref().map(|active| active.turn), plan_id, Some(content));
                            }
                        }
                        SessionUpdate::PlanRemoved(removed) => route.updates.update_plan_content(route.active.as_ref().map(|active| active.turn), removed.plan_id.to_string(), None),
                        update if route.active.is_some() => {
                            if let Some(active) = &mut route.active {
                                match update {
                                    SessionUpdate::AgentMessageChunk(chunk) => if let ContentBlock::Text(text) = chunk.content { route.updates.append_text(active.turn, text.text); },
                                    SessionUpdate::AgentThoughtChunk(chunk) => if let ContentBlock::Text(text) = chunk.content { route.updates.append_thought(active.turn, text.text, chunk.message_id.map(|id| id.to_string())); },
                                    SessionUpdate::Plan(plan) => { route.updates.update_plan(active.turn, plan); },
                                    SessionUpdate::ToolCall(tool) => { route.updates.update_tool(active.turn, tool.into()); },
                                    SessionUpdate::ToolCallUpdate(tool) => { route.updates.update_tool(active.turn, tool); },
                                    _ => {},
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            Ok(())
        }, agent_client_protocol::on_receive_notification!())
        .on_receive_notification(async move |notification: AuthStatusUpdate, _cx| {
            let status = notification.auth_status;
            if let Ok(mut pending) = auth_status_pending.lock() {
                *pending = Some(status.clone());
            }
            if auth_status_enabled.load(Ordering::Acquire) {
                record_auth_status(
                    &auth_status_agent,
                    &status,
                    &auth_status_evidence,
                    &auth_status_observations,
                );
            }
            Ok(())
        }, agent_client_protocol::on_receive_notification!())
        .connect_with(ByteStreams::new(stdin.compat_write(), stdout.compat()), async |connection: ConnectionTo<Agent>| {
            let initialize = InitializeRequest::new(ProtocolVersion::V1).client_capabilities(
                ClientCapabilities::new().elicitation(agent_client_protocol::schema::v1::ElicitationCapabilities::new().form(agent_client_protocol::schema::v1::ElicitationFormCapabilities::new())).plan(PlanCapabilities::new()).session(
                    ClientSessionCapabilities::new().config_options(
                        SessionConfigOptionsCapabilities::new()
                            .boolean(BooleanConfigOptionCapabilities::new()),
                    ),
                ),
            );
            let sent = connection.send_request(initialize);
            let _initial_lease = initial_updates.as_ref().map(|updates| elicitation::Lease::new(&sent, &owners, updates, Uuid::new_v4()));
            let initialized = match elicitation::timeout(sent.block_task(), || initial_updates.as_ref().is_some_and(RuntimeUpdates::waiting_for_input)).await {
                Ok(Ok(initialized)) if initialized.protocol_version == ProtocolVersion::V1 => initialized,
                Ok(Ok(_)) => return Ok(ConnectionFailure::InitializationFailed),
                Ok(Err(error)) => return Ok(classify(error, ConnectionFailure::InitializationFailed)),
                Err(_) => return Ok(ConnectionFailure::TimedOut),
            };
            drop(_initial_lease);
            let logout_supported = initialized.agent_capabilities.auth.logout.is_some();
            if let Ok(mut observations) = authentication_observations.lock() {
                observations.insert(
                    agent.id.clone(),
                    AuthenticationObservation {
                        logout_supported,
                        ..AuthenticationObservation::default()
                    },
                );
            }
            if supports_auth_status(&initialized.agent_capabilities) {
                auth_status_supported.store(true, Ordering::Release);
                if let Some(status) = pending_auth_status
                    .lock()
                    .ok()
                    .and_then(|status| status.clone())
                {
                    record_auth_status(
                        &agent.id,
                        &status,
                        &authentication,
                        &authentication_observations,
                    );
                }
            }
            let (finished, mut completions) = mpsc::unbounded_channel();
            let mut session_stops = HashMap::<Uuid, oneshot::Sender<()>>::new();
            loop {
                tokio::select! {
                    _ = connection.incoming_closed() => return Ok(ConnectionFailure::ConnectionClosed),
                    Some((id, generation, failure)) = completions.recv() => {
                        let participant = participants.lock().map(|mut all| {
                            let remaining = all.len();
                            all.get(&id).is_some_and(|updates| updates.generation() == generation && updates.is_current()).then(|| {
                                let updates = (remaining > 1).then(|| all.remove(&id)).flatten();
                                (remaining, updates)
                            })
                        }).unwrap_or_default();
                        let Some((remaining, updates)) = participant else {
                            continue;
                        };
                        session_stops.remove(&id);
                        // A sole failed session keeps the old reap-before-retry contract.
                        if remaining <= 1 { return Ok(failure); }
                        if let Some(updates) = updates { updates.connection_failed(failure); }
                        if let Ok(mut routes) = routes.lock() { routes.retain(|_, route| route.owner != id); }
                    },
                    command = async { match first_command.take() { Some(command) => Some(command), None => commands.recv().await } } => {
                        let Some(command) = command else { return Ok(ConnectionFailure::ConnectionClosed); };
                        match command {
                            RuntimeCommand::StartSession(session) => {
                                if let Some(stop) = session_stops.remove(&session.id) { let _ = stop.send(()); }
                                if let Ok(mut routes) = routes.lock() { routes.retain(|_, route| route.owner != session.id); }
                                let (stop, stopped) = oneshot::channel();
                                session_stops.insert(session.id, stop);
                                if let Ok(mut all) = participants.lock() { all.insert(session.id, session.updates.clone()); }
                                let finished = finished.clone();
                                let connection_task = connection.clone();
                                let capabilities = initialized.agent_capabilities.clone();
                                let folder = folder.clone();
                                let routes = routes.clone();
                                let owners = owners.clone();
                                connection.spawn(async move {
                                    let id = session.id;
                                    let generation = session.updates.generation();
                                    let failure = tokio::select! {
                                        biased;
                                        _ = stopped => ConnectionFailure::ConnectionClosed,
                                        failure = run_session(connection_task, capabilities, folder, routes, owners, session) => failure,
                                    };
                                    let _ = finished.send((id, generation, failure));
                                    Ok(())
                                })?;
                            }
                            RuntimeCommand::DeleteSession { owner, session_id, inputs_to_close } => {
                                if let Some(stop) = session_stops.remove(&owner) { let _ = stop.send(()); }
                                if let Ok(mut all) = participants.lock() { all.remove(&owner); }
                                if let Ok(mut routes) = routes.lock() { routes.retain(|_, route| route.owner != owner); }
                                drop(inputs_to_close);
                                if initialized.agent_capabilities.session_capabilities.delete.is_none() {
                                    continue;
                                }
                                let deletion = connection.clone();
                                if connection.spawn(async move {
                                    if deletion.send_request(DeleteSessionRequest::new(session_id)).block_task().await.is_err() {
                                        eprintln!("ACP session deletion failed");
                                    }
                                    Ok(())
                                }).is_err() {
                                    eprintln!("ACP session deletion could not be started");
                                }
                            }
                        }
                    }
                }
            }
        }));
    let failure = tokio::select! {
        biased;
        _ = &mut stop => None,
        _ = child.wait() => {
            match tokio::time::timeout(Duration::from_secs(1), &mut protocol).await {
                Ok(Ok(failure)) if failure != ConnectionFailure::ConnectionClosed => Some(failure),
                _ => Some(ConnectionFailure::ProcessExited),
            }
        },
        result = &mut protocol => {
            let failure = result.unwrap_or(ConnectionFailure::ConnectionClosed);
            if failure == ConnectionFailure::ConnectionClosed && tokio::time::timeout(Duration::from_millis(100), child.wait()).await.is_ok_and(|result| result.is_ok()) {
                Some(ConnectionFailure::ProcessExited)
            } else { Some(failure) }
        },
    };
    drop(protocol);
    commands.close();
    let reaped_gracefully = failure.is_none()
        && tokio::time::timeout(Duration::from_secs(1), child.wait())
            .await
            .is_ok_and(|result| result.is_ok());
    let reaped = if reaped_gracefully {
        group.disarm();
        true
    } else {
        let group_signalled = tokio::task::spawn_blocking(move || {
            let signalled = group.kill();
            group.disarm();
            signalled
        })
        .await
        .unwrap_or(false);
        let _ = child.kill().await;
        group_signalled && child.wait().await.is_ok()
    };
    let mut all = participants
        .lock()
        .map(|mut all| std::mem::take(&mut *all))
        .unwrap_or_default();
    while let Some(command) = commands.recv().await {
        match command {
            RuntimeCommand::StartSession(session) => {
                all.insert(session.id, session.updates);
            }
            RuntimeCommand::DeleteSession { .. } => {
                eprintln!("ACP session deletion connection closed before the request");
            }
        }
    }
    for updates in all.into_values() {
        match &failure {
            Some(failure) => updates.connection_failed(failure.clone()),
            None => updates.connection_closed(),
        }
    }
    reaped
}

fn record_auth_status(
    agent_id: &str,
    status: &AuthStatus,
    authentication: &Mutex<HashMap<String, crate::thread::AuthenticationStatus>>,
    observations: &Mutex<HashMap<String, AuthenticationObservation>>,
) {
    let logout_supported = observations
        .lock()
        .ok()
        .and_then(|observations| {
            observations
                .get(agent_id)
                .map(|value| value.logout_supported)
        })
        .unwrap_or(false);
    if let Ok(mut observations) = observations.lock() {
        observations.insert(agent_id.into(), status.observation(logout_supported));
    }
    if let Ok(mut authentication) = authentication.lock() {
        authentication.insert(
            agent_id.into(),
            if status.authenticated() {
                crate::thread::AuthenticationStatus::Authenticated
            } else {
                crate::thread::AuthenticationStatus::Unknown
            },
        );
    }
}

enum PromptFailure {
    Request,
    Connection(ConnectionFailure),
}

fn classify_prompt(error: agent_client_protocol::Error) -> PromptFailure {
    if agent_client_protocol::is_incoming_transport_closed(&error) {
        PromptFailure::Connection(ConnectionFailure::ConnectionClosed)
    } else if error.code == ErrorCode::AuthRequired {
        PromptFailure::Connection(ConnectionFailure::AuthenticationRequired)
    } else {
        PromptFailure::Request
    }
}

fn report_prompt_failure(
    updates: &RuntimeUpdates,
    failure: &PromptFailure,
    turn: uuid::Uuid,
    input: crate::thread::UserInput,
    queued_message: Option<uuid::Uuid>,
) {
    match failure {
        PromptFailure::Request => updates.request_failed(turn, input, queued_message),
        PromptFailure::Connection(_) => {
            // connection_failed restores queued input together with the failed connection state.
            if queued_message.is_none() {
                updates.direct_prompt_failed(turn, input);
            }
        }
    }
}

async fn run_session(
    connection: ConnectionTo<Agent>,
    capabilities: AgentCapabilities,
    folder: PathBuf,
    routes: Routes,
    owners: elicitation::Owners,
    mut session: Session,
) -> ConnectionFailure {
    let updates = &session.updates;
    let handshake = async {
        if let Some(id) = &session.remote_session {
            if let Ok(mut routes) = routes.lock() {
                routes.insert(
                    id.clone(),
                    Route {
                        owner: session.id,
                        updates: updates.clone(),
                        active: None,
                        replay: Some(replay::Replay::new()),
                    },
                );
            }
            let configuration = if capabilities.load_session {
                let response = elicitation::call(
                    connection.send_request(LoadSessionRequest::new(id.clone(), &folder)),
                    &owners,
                    updates,
                )
                .await
                .map_err(|error| classify(error, ConnectionFailure::SessionRestorationFailed))?;
                let history = routes
                    .lock()
                    .ok()
                    .and_then(|mut routes| routes.get_mut(id)?.replay.take());
                if let Some(history) = history {
                    updates.history_restored(history.turns);
                }
                response.config_options.unwrap_or_default()
            } else if capabilities.session_capabilities.resume.is_some() {
                let response = elicitation::call(
                    connection.send_request(ResumeSessionRequest::new(id.clone(), &folder)),
                    &owners,
                    updates,
                )
                .await
                .map_err(|error| classify(error, ConnectionFailure::SessionRestorationFailed))?;
                if let Ok(mut routes) = routes.lock() {
                    if let Some(route) = routes.get_mut(id) {
                        route.replay = None;
                    }
                }
                updates.context_resumed();
                response.config_options.unwrap_or_default()
            } else {
                return Err(ConnectionFailure::ResumptionUnsupported);
            };
            Ok((
                SessionId::new(id.clone()),
                thread_configuration(configuration),
            ))
        } else {
            let response = elicitation::call(
                connection.send_request(NewSessionRequest::new(&folder)),
                &owners,
                updates,
            )
            .await
            .map_err(|error| classify(error, ConnectionFailure::SessionCreationFailed))?;
            if let Ok(mut routes) = routes.lock() {
                routes.insert(
                    response.session_id.to_string(),
                    Route {
                        owner: session.id,
                        updates: updates.clone(),
                        active: None,
                        replay: None,
                    },
                );
            }
            let remote = response.session_id;
            let mut configuration =
                thread_configuration(response.config_options.unwrap_or_default());
            for remembered in &session.initial_configuration {
                let value = remembered.value();
                let Some(option) = configuration
                    .iter()
                    .find(|option| option.id == remembered.id)
                else {
                    continue;
                };
                if !option.accepts(&value) || option.has_value(&value) {
                    continue;
                }
                let value = match value {
                    ThreadConfigurationValue::Select { value } => {
                        SessionConfigOptionValue::value_id(value)
                    }
                    ThreadConfigurationValue::Boolean { value } => {
                        SessionConfigOptionValue::boolean(value)
                    }
                };
                match elicitation::call(
                    connection.send_request(SetSessionConfigOptionRequest::new(
                        remote.clone(),
                        remembered.id.clone(),
                        value,
                    )),
                    &owners,
                    updates,
                )
                .await
                {
                    Ok(response) => configuration = thread_configuration(response.config_options),
                    Err(_) => updates.configuration_inheritance_failed(),
                }
            }
            Ok((remote, configuration))
        }
    };
    let (remote, configuration) =
        match elicitation::timeout(handshake, || updates.waiting_for_input()).await {
            Ok(Ok(remote)) => remote,
            Ok(Err(failure)) => return failure,
            Err(_) => return ConnectionFailure::TimedOut,
        };
    let mut configuration_changes = Box::pin(run_configuration_changes(
        connection.clone(),
        remote.clone(),
        updates.clone(),
        session.configuration,
        owners.clone(),
    ));
    let mut next_prompt = updates.session_ready(
        remote.to_string(),
        configuration,
        crate::thread::PromptCapabilities {
            image: capabilities.prompt_capabilities.image,
            audio: capabilities.prompt_capabilities.audio,
        },
    );
    loop {
        let prompt = match next_prompt.take() {
            Some(prompt) => prompt,
            None => tokio::select! {
                prompt = session.prompts.recv() => match prompt {
                    Some(prompt) => prompt,
                    None => return ConnectionFailure::ConnectionClosed,
                },
                failure = &mut configuration_changes => return failure,
            },
        };
        if let Ok(mut routes) = routes.lock() {
            if let Some(route) = routes.get_mut(&remote.to_string()) {
                route.active = Some(ActiveTurn { turn: prompt.turn });
            }
        }
        let (finished, mut completion) = oneshot::channel();
        let turn_updates = updates.clone();
        let turn_routes = routes.clone();
        let turn_session = remote.to_string();
        let prompt_turn = prompt.turn;
        let queued_message = prompt.queued_message;
        let prompt_input = prompt.input;
        let content = match prompt_content(updates, &prompt_input) {
            Ok(content) => content,
            Err(failure) => {
                report_prompt_failure(updates, &failure, prompt_turn, prompt_input, queued_message);
                if let Ok(mut routes) = routes.lock() {
                    if let Some(route) = routes.get_mut(&remote.to_string()) {
                        route.active = None;
                    }
                }
                continue;
            }
        };
        let completed_input = prompt_input.clone();
        let sent = connection.send_request(PromptRequest::new(remote.clone(), content));
        let lease = elicitation::Lease::new(&sent, &owners, updates, prompt_turn);
        if let Err(error) = sent.on_receiving_result(async move |result| {
            drop(lease);
            if let Ok(mut routes) = turn_routes.lock() {
                if let Some(route) = routes
                    .get_mut(&turn_session)
                    .filter(|route| route.updates.generation() == turn_updates.generation())
                {
                    route.active = None;
                }
            }
            let completed = match result {
                Ok(response) => Ok(turn_updates.complete_turn(prompt_turn, response.stop_reason)),
                Err(error) => {
                    let failure = classify_prompt(error);
                    report_prompt_failure(
                        &turn_updates,
                        &failure,
                        prompt_turn,
                        completed_input,
                        queued_message,
                    );
                    Err(failure)
                }
            };
            let _ = finished.send(completed);
            Ok(())
        }) {
            let failure = classify_prompt(error);
            report_prompt_failure(updates, &failure, prompt_turn, prompt_input, queued_message);
            if let Ok(mut routes) = routes.lock() {
                if let Some(route) = routes.get_mut(&remote.to_string()) {
                    route.active = None;
                }
            }
            match failure {
                PromptFailure::Request => continue,
                PromptFailure::Connection(failure) => return failure,
            }
        }
        if let Some(queued_message) = queued_message {
            updates.queued_prompt_dispatched(queued_message);
        }
        // v1 prompt responses delimit turns; cancellation does not release the slot.
        loop {
            tokio::select! {
                biased;
                result = &mut completion => {
                    match result {
                        Ok(Ok(next)) => next_prompt = next,
                        Ok(Err(PromptFailure::Request)) => {}
                        Ok(Err(PromptFailure::Connection(failure))) => return failure,
                        Err(_) => return ConnectionFailure::ConnectionClosed,
                    }
                    break;
                }
                Some(turn) = session.cancellations.recv() => {
                    if turn == prompt_turn {
                        if let Err(error) = connection.send_notification(CancelNotification::new(remote.clone())) { return classify(error, ConnectionFailure::ConnectionClosed); }
                    }
                }
                failure = &mut configuration_changes => return failure,
            }
        }
    }
}

fn prompt_content(
    updates: &RuntimeUpdates,
    input: &crate::thread::UserInput,
) -> Result<Vec<ContentBlock>, PromptFailure> {
    let mut content =
        Vec::with_capacity(usize::from(!input.body.trim().is_empty()) + input.attachments.len());
    if !input.body.trim().is_empty() {
        content.push(input.body.clone().into());
    }
    for attachment in &input.attachments {
        content.push(match attachment.kind {
            AttachmentKind::File => ContentBlock::ResourceLink(ResourceLink::new(
                attachment.name.clone(),
                attachment.uri.clone().ok_or(PromptFailure::Request)?,
            )),
            AttachmentKind::Image => ContentBlock::Image(
                ImageContent::new(
                    BASE64.encode(
                        updates
                            .media_bytes(attachment.id)
                            .map_err(|_| PromptFailure::Request)?,
                    ),
                    attachment.mime_type.clone().ok_or(PromptFailure::Request)?,
                )
                .meta(attachment_meta(attachment)),
            ),
            AttachmentKind::Audio => ContentBlock::Audio(
                AudioContent::new(
                    BASE64.encode(
                        updates
                            .media_bytes(attachment.id)
                            .map_err(|_| PromptFailure::Request)?,
                    ),
                    attachment.mime_type.clone().ok_or(PromptFailure::Request)?,
                )
                .meta(attachment_meta(attachment)),
            ),
        });
    }
    Ok(content)
}

fn attachment_meta(attachment: &Attachment) -> Meta {
    let mut meta = Meta::new();
    meta.insert("atte/name".into(), attachment.name.clone().into());
    meta
}

async fn run_configuration_changes(
    connection: ConnectionTo<Agent>,
    session: SessionId,
    updates: RuntimeUpdates,
    mut changes: mpsc::UnboundedReceiver<ConfigurationChange>,
    owners: elicitation::Owners,
) -> ConnectionFailure {
    let mut pending = VecDeque::new();
    loop {
        let Some(change) = next_configuration_change(&mut changes, &mut pending).await else {
            return ConnectionFailure::ConnectionClosed;
        };
        if !updates.prepare_configuration_change(
            change.request_id,
            &change.config_id,
            &change.value,
        ) {
            let _ = change.complete.send(Ok(()));
            continue;
        }
        let value = match &change.value {
            ThreadConfigurationValue::Select { value } => {
                SessionConfigOptionValue::value_id(value.clone())
            }
            ThreadConfigurationValue::Boolean { value } => {
                SessionConfigOptionValue::boolean(*value)
            }
        };
        let (finished, mut request) = oneshot::channel();
        let result_updates = updates.clone();
        let request_id = change.request_id;
        let config_id = change.config_id.clone();
        let sent = connection.send_request(SetSessionConfigOptionRequest::new(
            session.clone(),
            change.config_id,
            value,
        ));
        let lease = elicitation::Lease::new(&sent, &owners, &updates, request_id);
        if let Err(error) = sent.on_receiving_result(async move |result| {
            drop(lease);
            let completion = match result {
                Ok(response) => {
                    result_updates.configuration_succeeded(
                        request_id,
                        &config_id,
                        thread_configuration(response.config_options),
                    );
                    Ok(())
                }
                Err(_) => {
                    if result_updates.configuration_failed(request_id, &config_id) {
                        Err(ThreadError::NotReady(
                            "스레드 설정을 변경할 수 없습니다.".into(),
                        ))
                    } else {
                        Ok(())
                    }
                }
            };
            let _ = change.complete.send(completion);
            let _ = finished.send(());
            Ok(())
        }) {
            return classify(error, ConnectionFailure::ConnectionClosed);
        }
        loop {
            tokio::select! {
                result = &mut request => match result {
                    Ok(()) => break,
                    Err(_) => return ConnectionFailure::ConnectionClosed,
                },
                incoming = changes.recv() => match incoming {
                    Some(incoming) => queue_configuration_change(&mut pending, incoming),
                    None => return ConnectionFailure::ConnectionClosed,
                },
            }
        }
    }
}

async fn next_configuration_change(
    changes: &mut mpsc::UnboundedReceiver<ConfigurationChange>,
    pending: &mut VecDeque<ConfigurationChange>,
) -> Option<ConfigurationChange> {
    match pending.pop_front() {
        Some(change) => Some(change),
        None => changes.recv().await,
    }
}

fn queue_configuration_change(
    pending: &mut VecDeque<ConfigurationChange>,
    change: ConfigurationChange,
) {
    if let Some(index) = pending
        .iter()
        .position(|pending| pending.config_id == change.config_id)
    {
        if let Some(replaced) = pending.remove(index) {
            let _ = replaced.complete.send(Ok(()));
        }
        pending.insert(index, change);
    } else {
        pending.push_back(change);
    }
}

fn thread_configuration(options: Vec<SessionConfigOption>) -> Vec<ThreadConfiguration> {
    options
        .into_iter()
        .filter_map(|option| {
            let control = match option.kind {
                SessionConfigKind::Select(select) => ThreadConfigurationControl::Select {
                    current_value: select.current_value.to_string(),
                    options: match select.options {
                        SessionConfigSelectOptions::Ungrouped(options) => {
                            ThreadConfigurationSelectOptions::Flat {
                                options: options
                                    .into_iter()
                                    .map(thread_configuration_choice)
                                    .collect(),
                            }
                        }
                        SessionConfigSelectOptions::Grouped(groups) => {
                            ThreadConfigurationSelectOptions::Grouped {
                                groups: groups
                                    .into_iter()
                                    .map(|group| ThreadConfigurationGroup {
                                        id: group.group.to_string(),
                                        name: group.name,
                                        options: group
                                            .options
                                            .into_iter()
                                            .map(thread_configuration_choice)
                                            .collect(),
                                    })
                                    .collect(),
                            }
                        }
                        _ => {
                            eprintln!("unsupported ACP select option collection omitted");
                            return None;
                        }
                    },
                },
                SessionConfigKind::Boolean(boolean) => ThreadConfigurationControl::Boolean {
                    current_value: boolean.current_value,
                },
                _ => {
                    eprintln!("unsupported ACP thread configuration kind omitted");
                    return None;
                }
            };
            Some(ThreadConfiguration {
                id: option.id.to_string(),
                name: option.name,
                description: option.description,
                category: option.category.and_then(|category| {
                    serde_json::to_value(category)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_owned))
                }),
                control,
            })
        })
        .collect()
}

fn thread_configuration_choice(choice: SessionConfigSelectOption) -> ThreadConfigurationChoice {
    ThreadConfigurationChoice {
        value: choice.value.to_string(),
        name: choice.name,
        description: choice.description,
    }
}

struct ActiveTurn {
    turn: Uuid,
}

fn classify(error: agent_client_protocol::Error, fallback: ConnectionFailure) -> ConnectionFailure {
    if agent_client_protocol::is_incoming_transport_closed(&error) {
        ConnectionFailure::ConnectionClosed
    } else if error.code == ErrorCode::AuthRequired {
        ConnectionFailure::AuthenticationRequired
    } else {
        fallback
    }
}
