//! ACP stdio ownership. Process isolation is internal, not part of the UI contract.
mod replay;
use crate::{
    agent::AgentDefinition,
    conversation::{
        AuthenticationStatus, ConnectionFailure, ConversationStatus, PermissionOption,
        PermissionRequest, Prompt, RuntimeUpdates,
    },
};
use agent_client_protocol::{
    schema::{
        v1::{
            CancelNotification, ContentBlock, InitializeRequest, LoadSessionRequest,
            NewSessionRequest, PromptRequest, RequestPermissionOutcome, RequestPermissionRequest,
            RequestPermissionResponse, ResumeSessionRequest, SelectedPermissionOutcome, SessionId,
            SessionNotification, SessionUpdate, ToolCallContent, ToolCallUpdate,
            ToolCallUpdateFields,
        },
        ProtocolVersion,
    },
    Agent, ByteStreams, Client, ConnectionTo, ErrorCode,
};
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

pub(crate) async fn run(
    agent: AgentDefinition,
    folder: PathBuf,
    remote_session: Option<String>,
    updates: RuntimeUpdates,
    mut stop: oneshot::Receiver<()>,
    mut prompts: mpsc::UnboundedReceiver<Prompt>,
    mut cancellations: mpsc::UnboundedReceiver<uuid::Uuid>,
) {
    let mut command = Command::new(&agent.command);
    command
        .args(&agent.args)
        .envs(&agent.env)
        .current_dir(&folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // An adapter may spawn its own agent. Keep the entire tree in our process group.
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            failed(
                &updates,
                if error.kind() == std::io::ErrorKind::NotFound {
                    ConnectionFailure::ExecutableNotFound
                } else {
                    ConnectionFailure::LaunchFailed
                },
            );
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
    let active = Arc::new(Mutex::new(None::<ActiveTurn>));
    let replay = Arc::new(Mutex::new(remote_session.clone().map(replay::Replay::new)));
    let notification_replay = replay.clone();
    let notification_active = active.clone();
    let notification_updates = updates.clone();
    let permission_updates = updates.clone();
    let permission_active = active.clone();
    let protocol = Client
        .builder()
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, cx| {
                let decision = permission_active.lock().ok().and_then(|mut active| {
                    let active = active.as_mut().filter(|active| active.session == request.session_id.to_string())?;
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
                    permission_updates.request_permission(turn, PermissionRequest {
                        id: uuid::Uuid::new_v4(),
                        title: fields.title.clone().unwrap_or(tool_id),
                        details,
                        options: request.options.into_iter().map(|option| PermissionOption { id: option.option_id.to_string(), name: option.name }).collect(),
                    })
                });
                // Never hold the ordered dispatch loop while waiting for the user.
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
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                if let Ok(mut replay) = notification_replay.lock() {
                    if let Some(replay) = replay.as_mut().filter(|replay| replay.session == notification.session_id.to_string()) {
                        replay.update(notification.update);
                        return Ok(());
                    }
                }
                if let Ok(mut active) = notification_active.lock() {
                    if let Some(active) = active.as_mut().filter(|active| active.session == notification.session_id.to_string()) {
                        match notification.update {
                            SessionUpdate::AgentMessageChunk(chunk) => {
                                if let ContentBlock::Text(text) = chunk.content {
                                    notification_updates.append_text(active.turn, text.text);
                                }
                            }
                            SessionUpdate::ToolCall(tool) => { active.update_tool(tool.into()); }
                            SessionUpdate::ToolCallUpdate(tool) => { active.update_tool(tool); }
                            _ => {}
                        }
                    }
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_with(
            ByteStreams::new(stdin.compat_write(), stdout.compat()),
            async |connection: ConnectionTo<Agent>| {
                let handshake = async {
                    let initialized = connection
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task()
                        .await
                        .map_err(|error| {
                            classify(error, ConnectionFailure::InitializationFailed)
                        })?;
                    if initialized.protocol_version != ProtocolVersion::V1 {
                        return Err(ConnectionFailure::InitializationFailed);
                    }
                    if let Some(id) = remote_session {
                        if initialized.agent_capabilities.load_session {
                            connection.send_request(LoadSessionRequest::new(id.clone(), &folder))
                                .block_task().await.map_err(|error| classify(error, ConnectionFailure::SessionRestorationFailed))?;
                            let history = replay.lock().ok().and_then(|mut replay| replay.take());
                            if let Some(history) = history {
                                updates.modify(None, |snapshot| { snapshot.turns = history.turns; snapshot.notice = None; });
                            }
                        } else if initialized.agent_capabilities.session_capabilities.resume.is_some() {
                            connection.send_request(ResumeSessionRequest::new(id.clone(), &folder))
                                .block_task().await.map_err(|error| classify(error, ConnectionFailure::SessionRestorationFailed))?;
                            if let Ok(mut replay) = replay.lock() { *replay = None; }
                            updates.modify(None, |snapshot| {
                                snapshot.turns.clear();
                                snapshot.notice = Some("기존 맥락을 재개했습니다. 이 에이전트는 이전 메시지 표시를 지원하지 않습니다.".into());
                            });
                        } else {
                            return Err(ConnectionFailure::ResumptionUnsupported);
                        }
                        Ok(SessionId::new(id))
                    } else {
                        connection.send_request(NewSessionRequest::new(folder)).block_task().await
                            .map(|session| session.session_id)
                            .map_err(|error| classify(error, ConnectionFailure::SessionCreationFailed))
                    }
                };
                let session = match tokio::time::timeout(Duration::from_secs(30), handshake).await {
                    Ok(Ok(session)) => session,
                    Ok(Err(failure)) => return Ok(failure),
                    Err(_) => return Ok(ConnectionFailure::TimedOut),
                };
                updates.modify(None, |snapshot| {
                    snapshot.remote_session_id = Some(session.to_string());
                    snapshot.status = ConversationStatus::SessionReady;
                });
                loop {
                    let prompt = tokio::select! {
                        _ = connection.incoming_closed() => return Ok(ConnectionFailure::ConnectionClosed),
                        prompt = prompts.recv() => match prompt { Some(prompt) => prompt, None => return Ok(ConnectionFailure::ConnectionClosed) },
                    };
                    if let Ok(mut active) = active.lock() { *active = Some(ActiveTurn { session: session.to_string(), turn: prompt.turn, tools: HashMap::new() }); }
                    let (finished, mut completion) = oneshot::channel();
                    let turn_updates = updates.clone();
                    let turn_active = active.clone();
                    connection.send_request(PromptRequest::new(session.clone(), vec![prompt.text.into()]))
                        .on_receiving_result(async move |result| {
                            if let Ok(mut active) = turn_active.lock() { *active = None; }
                            let failure = match result {
                                Ok(response) => {
                                    turn_updates.record_authentication(AuthenticationStatus::Authenticated);
                                    turn_updates.modify(Some(prompt.turn), |snapshot| {
                                        snapshot.interrupted = response.stop_reason == agent_client_protocol::schema::v1::StopReason::Cancelled;
                                        if let Some(turn) = snapshot.turns.last_mut() {
                                            turn.stop_reason = serde_json::to_value(response.stop_reason).ok().and_then(|value| value.as_str().map(str::to_owned));
                                        }
                                        snapshot.status = ConversationStatus::SessionReady;
                                        snapshot.authentication = AuthenticationStatus::Authenticated;
                                    });
                                    None
                                }
                                Err(error) => Some(classify(error, ConnectionFailure::PromptFailed)),
                            };
                            let _ = finished.send(failure);
                            Ok(())
                        })?;
                    // ACP v1 updates have no turn ID. Keep the old turn active until
                    // its prompt response forms the protocol boundary for the next.
                    let result = loop {
                        tokio::select! {
                            biased;
                            result = &mut completion => break result,
                            Some(turn) = cancellations.recv() => {
                                if turn == prompt.turn {
                                    connection.send_notification(CancelNotification::new(session.clone()))?;
                                }
                            }
                        }
                    };
                    match result {
                        Ok(None) => {},
                        Ok(Some(failure)) => return Ok(failure),
                        Err(_) => return Ok(ConnectionFailure::ConnectionClosed),
                    }
                }
            },
        );
    tokio::pin!(protocol);
    let failure = tokio::select! {
        biased;
        _ = &mut stop => None,
        _ = child.wait() => {
            // EOF can race process exit. Drain already-written notifications before
            // publishing failure; descendants retaining stdout cannot delay it forever.
            match tokio::time::timeout(Duration::from_secs(1), &mut protocol).await {
                Ok(Ok(failure)) if failure != ConnectionFailure::ConnectionClosed => Some(failure),
                _ => Some(ConnectionFailure::ProcessExited),
            }
        },
        result = &mut protocol => {
            let failure = result.unwrap_or(ConnectionFailure::ConnectionClosed);
            // EOF can become readable just before the OS reports process exit.
            if failure == ConnectionFailure::ConnectionClosed
                && tokio::time::timeout(Duration::from_millis(100), child.wait()).await.is_ok_and(|result| result.is_ok()) {
                Some(ConnectionFailure::ProcessExited)
            } else {
                Some(failure)
            }
        },
    };
    drop(group);
    let _ = child.kill().await;
    let _ = child.wait().await;
    match failure {
        Some(failure) => failed(&updates, failure),
        None => {
            updates.modify(None, |snapshot| {
                snapshot.interrupted |= matches!(
                    snapshot.status,
                    ConversationStatus::Running
                        | ConversationStatus::WaitingForApproval
                        | ConversationStatus::Cancelling
                );
                snapshot.status = ConversationStatus::Disconnected;
            });
        }
    }
}

// Tool permission requests are partial updates; context may arrive beforehand.
struct ActiveTurn {
    session: String,
    turn: uuid::Uuid,
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

fn failed(updates: &RuntimeUpdates, failure: ConnectionFailure) {
    if failure == ConnectionFailure::AuthenticationRequired {
        updates.record_authentication(AuthenticationStatus::Required);
    }
    updates.modify(None, |snapshot| {
        snapshot.interrupted |= matches!(
            snapshot.status,
            ConversationStatus::Running
                | ConversationStatus::WaitingForApproval
                | ConversationStatus::Cancelling
        );
        snapshot.status = ConversationStatus::Failed;
        if failure == ConnectionFailure::AuthenticationRequired {
            snapshot.authentication = AuthenticationStatus::Required;
        }
        snapshot.failure = Some(failure);
    });
}

pub(crate) struct ProcessGroup(pub(crate) Option<u32>);

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(id) = self.0 {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(id as i32),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
    }
}
