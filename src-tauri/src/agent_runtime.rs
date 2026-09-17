//! ACP stdio ownership. Process isolation is internal, not part of the UI contract.
use crate::{
    agent::AgentDefinition,
    conversation::{AuthenticationStatus, ConnectionFailure, Conversation, ConversationStatus},
};
use agent_client_protocol::{
    schema::{
        v1::{
            InitializeRequest, NewSessionRequest, RequestPermissionOutcome,
            RequestPermissionRequest, RequestPermissionResponse,
        },
        ProtocolVersion,
    },
    Agent, ByteStreams, Client, ConnectionTo, ErrorCode,
};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    process::Command,
    sync::{oneshot, watch},
};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

pub(crate) async fn run(
    agent: AgentDefinition,
    folder: PathBuf,
    updates: watch::Sender<Conversation>,
    mut stop: oneshot::Receiver<()>,
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
    let protocol = Client
        .builder()
        .on_receive_request(
            async move |_request: RequestPermissionRequest, responder, _cx| {
                responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
            },
            agent_client_protocol::on_receive_request!(),
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
                updates.send_modify(|snapshot| {
                    snapshot.remote_session_id = Some(session.session_id.to_string());
                    snapshot.status = ConversationStatus::SessionReady;
                });
                connection.incoming_closed().await;
                Ok(ConnectionFailure::ConnectionClosed)
            },
        );
    let failure = tokio::select! {
        biased;
        _ = &mut stop => None,
        _ = child.wait() => Some(ConnectionFailure::ProcessExited),
        result = protocol => Some(result.unwrap_or(ConnectionFailure::ConnectionClosed)),
    };
    drop(group);
    let _ = child.kill().await;
    let _ = child.wait().await;
    match failure {
        Some(failure) => failed(&updates, failure),
        None => {
            updates.send_modify(|snapshot| {
                snapshot.status = ConversationStatus::Disconnected;
                snapshot.remote_session_id = None;
            });
        }
    }
}

fn classify(error: agent_client_protocol::Error, fallback: ConnectionFailure) -> ConnectionFailure {
    if error.code == ErrorCode::AuthRequired {
        ConnectionFailure::AuthenticationRequired
    } else {
        fallback
    }
}

fn failed(updates: &watch::Sender<Conversation>, failure: ConnectionFailure) {
    updates.send_modify(|snapshot| {
        snapshot.status = ConversationStatus::Failed;
        if failure == ConnectionFailure::AuthenticationRequired {
            snapshot.authentication = AuthenticationStatus::Required;
        }
        snapshot.failure = Some(failure);
    });
}

struct ProcessGroup(Option<u32>);

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
