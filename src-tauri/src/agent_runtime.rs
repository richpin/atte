//! Shared ACP stdio connection with independent, session-scoped execution.
mod process;
mod replay;
use crate::{
    agent::AgentDefinition,
    thread::{ConnectionFailure, PermissionOption, PermissionRequest, Prompt, RuntimeUpdates},
};
use agent_client_protocol::{
    schema::{
        v1::{
            AgentCapabilities, CancelNotification, ContentBlock, DeleteSessionRequest,
            InitializeRequest, LoadSessionRequest, NewSessionRequest, PromptRequest,
            RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
            ResumeSessionRequest, SelectedPermissionOutcome, SessionId, SessionNotification,
            SessionUpdate, ToolCallContent, ToolCallUpdate, ToolCallUpdateFields,
        },
        ProtocolVersion,
    },
    Agent, ByteStreams, Client, ConnectionTo, ErrorCode,
};
pub(crate) use process::ProcessGroup;
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
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
    pub updates: RuntimeUpdates,
    pub prompts: mpsc::UnboundedReceiver<Prompt>,
    pub cancellations: mpsc::UnboundedReceiver<Uuid>,
}

pub(crate) struct SessionInputSenders {
    pub prompts: mpsc::UnboundedSender<Prompt>,
    pub cancellations: mpsc::UnboundedSender<Uuid>,
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
) {
    let Ok(launch) = crate::agent_management::node_runtime::resolve_launch(&agent).await else {
        commands.close();
        while let Some(command) = commands.recv().await {
            if let RuntimeCommand::StartSession(session) = command {
                session
                    .updates
                    .connection_failed(ConnectionFailure::ExecutableNotFound);
            }
        }
        return;
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
            return;
        }
    };
    let group = ProcessGroup(child.id());
    let Some(stdin) = child.stdin.take() else {
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        return;
    };
    let routes: Routes = Arc::default();
    let participants = Arc::new(Mutex::new(HashMap::<Uuid, RuntimeUpdates>::new()));
    let permission_routes = routes.clone();
    let notification_routes = routes.clone();
    let mut protocol = Box::pin(Client.builder()
        .on_receive_request(async move |request: RequestPermissionRequest, responder, cx| {
            let decision = permission_routes.lock().ok().and_then(|mut routes| {
                let route = routes.get_mut(&request.session_id.to_string())?;
                let active = route.active.as_mut()?;
                let turn = active.turn;
                let tool_id = request.tool_call.tool_call_id.to_string();
                let fields = active.update_tool(request.tool_call);
                let details = [
                    fields.raw_input.as_ref().and_then(|value| serde_json::to_string_pretty(value).ok()),
                    fields.content.as_ref().and_then(|content| {
                        let visible: Vec<_> = content.iter().filter(|item| !matches!(item, ToolCallContent::Terminal(_))).collect();
                        (!visible.is_empty()).then(|| serde_json::to_string_pretty(&visible).ok()).flatten()
                    }),
                    fields.locations.as_ref().filter(|locations| !locations.is_empty()).and_then(|value| serde_json::to_string_pretty(value).ok()),
                ].into_iter().flatten().collect::<Vec<_>>().join("\n");
                route.updates.request_permission(turn, PermissionRequest {
                    id: Uuid::new_v4(), title: fields.title.clone().unwrap_or(tool_id), details,
                    options: request.options.into_iter().map(|option| PermissionOption { id: option.option_id.to_string(), name: option.name }).collect(),
                })
            });
            // Waiting for one user's decision must not block another session.
            cx.spawn(async move {
                let outcome = match decision {
                    Some(decision) => match decision.await {
                        Ok(option) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option)),
                        Err(_) => RequestPermissionOutcome::Cancelled,
                    },
                    None => RequestPermissionOutcome::Cancelled,
                };
                responder.respond(RequestPermissionResponse::new(outcome))
            })
        }, agent_client_protocol::on_receive_request!())
        .on_receive_notification(async move |notification: SessionNotification, _cx| {
            if let Ok(mut routes) = notification_routes.lock() {
                if let Some(route) = routes.get_mut(&notification.session_id.to_string()) {
                    if let Some(replay) = &mut route.replay {
                        replay.update(notification.update);
                    } else if let Some(active) = &mut route.active {
                        match notification.update {
                            SessionUpdate::AgentMessageChunk(chunk) => if let ContentBlock::Text(text) = chunk.content { route.updates.append_text(active.turn, text.text); },
                            SessionUpdate::ToolCall(tool) => { active.update_tool(tool.into()); },
                            SessionUpdate::ToolCallUpdate(tool) => { active.update_tool(tool); },
                            _ => {},
                        }
                    }
                }
            }
            Ok(())
        }, agent_client_protocol::on_receive_notification!())
        .connect_with(ByteStreams::new(stdin.compat_write(), stdout.compat()), async |connection: ConnectionTo<Agent>| {
            let initialized = match tokio::time::timeout(Duration::from_secs(30), connection.send_request(InitializeRequest::new(ProtocolVersion::V1)).block_task()).await {
                Ok(Ok(initialized)) if initialized.protocol_version == ProtocolVersion::V1 => initialized,
                Ok(Ok(_)) => return Ok(ConnectionFailure::InitializationFailed),
                Ok(Err(error)) => return Ok(classify(error, ConnectionFailure::InitializationFailed)),
                Err(_) => return Ok(ConnectionFailure::TimedOut),
            };
            let (finished, mut completions) = mpsc::unbounded_channel();
            loop {
                tokio::select! {
                    _ = connection.incoming_closed() => return Ok(ConnectionFailure::ConnectionClosed),
                    Some((id, failure)) = completions.recv() => {
                        let participant = participants.lock().map(|mut all| {
                            let remaining = all.len();
                            all.contains_key(&id).then(|| {
                                let updates = (remaining > 1).then(|| all.remove(&id)).flatten();
                                (remaining, updates)
                            })
                        }).unwrap_or_default();
                        let Some((remaining, updates)) = participant else {
                            if let Ok(mut routes) = routes.lock() { routes.retain(|_, route| route.owner != id); }
                            continue;
                        };
                        // A sole failed session keeps the old reap-before-retry contract.
                        if remaining <= 1 { return Ok(failure); }
                        if let Some(updates) = updates { updates.connection_failed(failure); }
                        if let Ok(mut routes) = routes.lock() { routes.retain(|_, route| route.owner != id); }
                    },
                    command = commands.recv() => {
                        let Some(command) = command else { return Ok(ConnectionFailure::ConnectionClosed); };
                        match command {
                            RuntimeCommand::StartSession(session) => {
                                if let Ok(mut all) = participants.lock() { all.insert(session.id, session.updates.clone()); }
                                let finished = finished.clone();
                                let connection_task = connection.clone();
                                let capabilities = initialized.agent_capabilities.clone();
                                let folder = folder.clone();
                                let routes = routes.clone();
                                connection.spawn(async move {
                                    let id = session.id;
                                    let failure = run_session(connection_task, capabilities, folder, routes, session).await;
                                    let _ = finished.send((id, failure));
                                    Ok(())
                                })?;
                            }
                            RuntimeCommand::DeleteSession { owner, session_id, inputs_to_close } => {
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
    drop(group);
    drop(protocol);
    commands.close();
    let _ = child.kill().await;
    let _ = child.wait().await;
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
}

async fn run_session(
    connection: ConnectionTo<Agent>,
    capabilities: AgentCapabilities,
    folder: PathBuf,
    routes: Routes,
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
            if capabilities.load_session {
                connection
                    .send_request(LoadSessionRequest::new(id.clone(), &folder))
                    .block_task()
                    .await
                    .map_err(|error| {
                        classify(error, ConnectionFailure::SessionRestorationFailed)
                    })?;
                let history = routes
                    .lock()
                    .ok()
                    .and_then(|mut routes| routes.get_mut(id)?.replay.take());
                if let Some(history) = history {
                    updates.history_restored(history.turns);
                }
            } else if capabilities.session_capabilities.resume.is_some() {
                connection
                    .send_request(ResumeSessionRequest::new(id.clone(), &folder))
                    .block_task()
                    .await
                    .map_err(|error| {
                        classify(error, ConnectionFailure::SessionRestorationFailed)
                    })?;
                if let Ok(mut routes) = routes.lock() {
                    if let Some(route) = routes.get_mut(id) {
                        route.replay = None;
                    }
                }
                updates.context_resumed();
            } else {
                return Err(ConnectionFailure::ResumptionUnsupported);
            }
            Ok(SessionId::new(id.clone()))
        } else {
            let response = connection
                .send_request(NewSessionRequest::new(&folder))
                .block_task()
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
            Ok(response.session_id)
        }
    };
    let remote = match tokio::time::timeout(Duration::from_secs(30), handshake).await {
        Ok(Ok(remote)) => remote,
        Ok(Err(failure)) => return failure,
        Err(_) => return ConnectionFailure::TimedOut,
    };
    updates.session_ready(remote.to_string());
    let mut next_prompt = None;
    loop {
        let prompt = match next_prompt.take() {
            Some(prompt) => prompt,
            None => match session.prompts.recv().await {
                Some(prompt) => prompt,
                None => return ConnectionFailure::ConnectionClosed,
            },
        };
        if let Ok(mut routes) = routes.lock() {
            if let Some(route) = routes.get_mut(&remote.to_string()) {
                route.active = Some(ActiveTurn {
                    turn: prompt.turn,
                    tools: HashMap::new(),
                });
            }
        }
        let (finished, mut completion) = oneshot::channel();
        let turn_updates = updates.clone();
        let turn_routes = routes.clone();
        let turn_session = remote.to_string();
        if let Err(error) = connection
            .send_request(PromptRequest::new(remote.clone(), vec![prompt.text.into()]))
            .on_receiving_result(async move |result| {
                if let Ok(mut routes) = turn_routes.lock() {
                    if let Some(route) = routes.get_mut(&turn_session) {
                        route.active = None;
                    }
                }
                let completed = match result {
                    Ok(response) => {
                        Ok(turn_updates.complete_turn(prompt.turn, response.stop_reason))
                    }
                    Err(error) => Err(classify(error, ConnectionFailure::PromptFailed)),
                };
                let _ = finished.send(completed);
                Ok(())
            })
        {
            return classify(error, ConnectionFailure::PromptFailed);
        }
        // v1 prompt responses delimit turns; cancellation does not release the slot.
        loop {
            tokio::select! {
                biased;
                result = &mut completion => {
                    match result {
                        Ok(Ok(next)) => next_prompt = next,
                        Ok(Err(failure)) => return failure,
                        Err(_) => return ConnectionFailure::ConnectionClosed,
                    }
                    break;
                }
                Some(turn) = session.cancellations.recv() => {
                    if turn == prompt.turn {
                        if let Err(error) = connection.send_notification(CancelNotification::new(remote.clone())) { return classify(error, ConnectionFailure::ConnectionClosed); }
                    }
                }
            }
        }
    }
}

// Tool permission requests are partial updates; context may arrive beforehand.
struct ActiveTurn {
    turn: Uuid,
    tools: HashMap<String, ToolCallUpdateFields>,
}

impl ActiveTurn {
    fn update_tool(&mut self, update: ToolCallUpdate) -> &ToolCallUpdateFields {
        let fields = self
            .tools
            .entry(update.tool_call_id.to_string())
            .or_default();
        let incoming = update.fields;
        if incoming.title.is_some() {
            fields.title = incoming.title;
        }
        if incoming.raw_input.is_some() {
            fields.raw_input = incoming.raw_input;
        }
        if incoming.content.is_some() {
            fields.content = incoming.content;
        }
        if incoming.locations.is_some() {
            fields.locations = incoming.locations;
        }
        fields
    }
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
