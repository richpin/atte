//! ACP stdio ownership. Process isolation is internal, not part of the UI contract.
use crate::{
    agent::AgentDefinition,
    conversation::{
        AuthenticationStatus, ConnectionFailure, ConversationStatus, Prompt, RuntimeUpdates,
    },
};
use agent_client_protocol::{
    schema::{
        v1::{
            ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest,
            RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
            SessionNotification, SessionUpdate,
        },
        ProtocolVersion,
    },
    Agent, ByteStreams, Client, ConnectionTo, ErrorCode,
};
use std::{
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
    updates: RuntimeUpdates,
    mut stop: oneshot::Receiver<()>,
    mut prompts: mpsc::UnboundedReceiver<Prompt>,
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
    let active = Arc::new(Mutex::new(None::<(String, uuid::Uuid)>));
    let notification_active = active.clone();
    let notification_updates = updates.clone();
    let permission_updates = updates.clone();
    let permission_active = active.clone();
    let protocol = Client
        .builder()
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                if let Ok(active) = permission_active.lock() {
                    if let Some((_, turn)) = active.as_ref().filter(|(session, _)| *session == request.session_id.to_string()) {
                        permission_updates.modify(Some(*turn), |snapshot| snapshot.notice = Some("승인 UI가 아직 지원되지 않아 도구 실행 요청을 취소했습니다.".into()));
                    }
                }
                responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                if let SessionUpdate::AgentMessageChunk(chunk) = notification.update {
                    if let ContentBlock::Text(text) = chunk.content {
                        if let Ok(active) = notification_active.lock() {
                            if let Some((_, turn)) = active.as_ref().filter(|(session, _)| *session == notification.session_id.to_string()) {
                                notification_updates.append_text(*turn, text.text);
                            }
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
                    connection
                        .send_request(NewSessionRequest::new(folder))
                        .block_task()
                        .await
                        .map_err(|error| classify(error, ConnectionFailure::SessionCreationFailed))
                };
                let session = match tokio::time::timeout(Duration::from_secs(30), handshake).await {
                    Ok(Ok(session)) => session,
                    Ok(Err(failure)) => return Ok(failure),
                    Err(_) => return Ok(ConnectionFailure::TimedOut),
                };
                updates.modify(None, |snapshot| {
                    snapshot.remote_session_id = Some(session.session_id.to_string());
                    snapshot.status = ConversationStatus::SessionReady;
                });
                loop {
                    let prompt = tokio::select! {
                        _ = connection.incoming_closed() => return Ok(ConnectionFailure::ConnectionClosed),
                        prompt = prompts.recv() => match prompt { Some(prompt) => prompt, None => return Ok(ConnectionFailure::ConnectionClosed) },
                    };
                    if let Ok(mut active) = active.lock() { *active = Some((session.session_id.to_string(), prompt.turn)); }
                    let (finished, completion) = oneshot::channel();
                    let turn_updates = updates.clone();
                    let turn_active = active.clone();
                    connection.send_request(PromptRequest::new(session.session_id.clone(), vec![prompt.text.into()]))
                        .on_receiving_result(async move |result| {
                            if let Ok(mut active) = turn_active.lock() { *active = None; }
                            let failure = match result {
                                Ok(response) => {
                                    turn_updates.record_authentication(AuthenticationStatus::Authenticated);
                                    turn_updates.modify(Some(prompt.turn), |snapshot| {
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
                    match completion.await {
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
                snapshot.status = ConversationStatus::Disconnected;
                snapshot.remote_session_id = None;
            });
        }
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
