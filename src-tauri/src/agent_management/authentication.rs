use super::ManagementError;
use crate::{agent::AgentDefinition, agent_runtime::ProcessGroup};
use agent_client_protocol::{
    schema::{
        v1::{
            AuthCapabilities, AuthMethod, AuthenticateRequest, ClientCapabilities,
            InitializeRequest,
        },
        ProtocolVersion,
    },
    Agent, ByteStreams, Client, ConnectionTo,
};
use serde::Serialize;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::process::Command;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Authentication {
    pub connected: bool,
    pub authenticated: bool,
    pub required: bool,
    pub methods: Vec<LoginMethod>,
}

#[derive(Clone, Debug, Serialize)]
pub struct LoginMethod {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub terminal: bool,
}

/// Initializes a separate setup connection. It never reuses or replaces conversations.
pub async fn inspect(
    agent: &AgentDefinition,
    folder: &Path,
    method: Option<&str>,
) -> Result<Authentication, ManagementError> {
    let mut command = Command::new(&agent.command);
    command
        .args(&agent.args)
        .envs(&agent.env)
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| ManagementError::Connection)?;
    let group = ProcessGroup(child.id());
    let stdin = child.stdin.take().ok_or(ManagementError::Connection)?;
    let stdout = child.stdout.take().ok_or(ManagementError::Connection)?;
    let protocol = Client.builder().connect_with(
        ByteStreams::new(stdin.compat_write(), stdout.compat()),
        async |connection: ConnectionTo<Agent>| {
            let result = async {
                let capabilities = ClientCapabilities::new()
                    .auth(AuthCapabilities::new().terminal(cfg!(target_os = "macos")));
                let initialized = connection
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_capabilities(capabilities),
                    )
                    .block_task()
                    .await
                    .map_err(|_| ManagementError::Connection)?;
                if initialized.protocol_version != ProtocolVersion::V1 {
                    return Err(ManagementError::Connection);
                }
                let mut state = Authentication {
                    connected: true,
                    authenticated: false,
                    required: false,
                    methods: initialized
                        .auth_methods
                        .iter()
                        .map(|method| LoginMethod {
                            id: method.id().to_string(),
                            name: method.name().to_owned(),
                            description: crate::agent::authentication_guidance(agent, method),
                            terminal: matches!(method, AuthMethod::Terminal(_)),
                        })
                        .collect(),
                };
                if let Some(id) = method {
                    let selected = initialized
                        .auth_methods
                        .iter()
                        .find(|method| method.id().to_string() == id)
                        .ok_or(ManagementError::Authentication)?;
                    crate::agent::check_authentication_prerequisite(agent, selected)?;
                    match selected {
                        AuthMethod::Agent(_) => {
                            connection
                                .send_request(AuthenticateRequest::new(selected.id().clone()))
                                .block_task()
                                .await
                                .map_err(|_| ManagementError::Authentication)?;
                        }
                        AuthMethod::Terminal(terminal) => {
                            terminal_login(agent, terminal, folder).await?
                        }
                        _ => return Err(ManagementError::Authentication),
                    }
                    state.authenticated = true;
                }
                Ok(state)
            }
            .await;
            Ok(result)
        },
    );
    let result = tokio::time::timeout(
        Duration::from_secs(if method.is_some() { 600 } else { 30 }),
        protocol,
    )
    .await;
    drop(group);
    let _ = child.kill().await;
    let _ = child.wait().await;
    match result {
        Ok(Ok(result)) => result,
        _ => Err(ManagementError::Connection),
    }
}

async fn terminal_login(
    agent: &AgentDefinition,
    method: &agent_client_protocol::schema::v1::AuthMethodTerminal,
    folder: &Path,
) -> Result<(), ManagementError> {
    if !cfg!(target_os = "macos") {
        return Err(ManagementError::Authentication);
    }
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().map_err(|_| ManagementError::Authentication)?;
    let status = directory.path().join("status");
    let script = directory.path().join("Atte-login.command");
    let mut env = agent.env.clone();
    env.extend(method.env.clone());
    let mut command = String::from("/usr/bin/env");
    for (key, value) in env {
        command.push(' ');
        command.push_str(&quote(&format!("{key}={value}")));
    }
    command.push(' ');
    command.push_str(&quote(&agent.command.to_string_lossy()));
    for arg in agent.args.iter().chain(&method.args) {
        command.push(' ');
        command.push_str(&quote(arg));
    }
    // The script and completion marker live in a private temporary directory. No terminal output is captured.
    std::fs::write(&script, format!("#!/bin/sh\ncd {} || exit 1\n{}\nresult=$?\nprintf '%s' \"$result\" > {}\nexit \"$result\"\n", quote(&folder.to_string_lossy()), command, quote(&status.to_string_lossy()))).map_err(|_| ManagementError::Authentication)?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| ManagementError::Authentication)?;
    let result = Command::new("/usr/bin/open")
        .args(["-a", "Terminal"])
        .arg(&script)
        .status()
        .await
        .map_err(|_| ManagementError::Authentication)?;
    if !result.success() {
        return Err(ManagementError::Authentication);
    }
    loop {
        if let Ok(result) = std::fs::read_to_string(&status) {
            return if result == "0" {
                Ok(())
            } else {
                Err(ManagementError::Authentication)
            };
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
