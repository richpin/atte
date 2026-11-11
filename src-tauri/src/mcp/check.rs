//! Explicit, isolated MCP initialize and tool discovery with bounded cleanup.
mod transport;
use super::*;
use rmcp::{
    service::{RoleClient, RunningService},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};
use std::{process::Stdio, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct Checks(Mutex<BTreeMap<Uuid, CancellationToken>>);
#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Connected,
    NoTools,
    AuthenticationRequired,
    NetworkError,
    ExecutionFailed,
    Timeout,
    Cancelled,
    InvalidConfiguration,
    ProtocolError,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub status: Status,
    pub tools: Vec<String>,
}
impl CheckResult {
    fn failed(status: Status) -> Self {
        Self {
            status,
            tools: vec![],
        }
    }
}
pub(super) struct Prepared {
    server: Server,
    values: BTreeMap<String, String>,
    folder: PathBuf,
    authorization: Option<Arc<oauth::Authorization>>,
}
impl Mcp {
    pub(super) fn prepare_check(
        &self,
        target: &Target,
        name: &str,
        folder: PathBuf,
    ) -> Result<Prepared, Status> {
        let _guard = self.lock.lock().map_err(|_| Status::InvalidConfiguration)?;
        let path = self
            .path(target)
            .map_err(|_| Status::InvalidConfiguration)?;
        let value = self
            .read(target)
            .map_err(|_| Status::InvalidConfiguration)?
            .remove(name)
            .ok_or(Status::InvalidConfiguration)?;
        let server: Server =
            serde_json::from_value(value).map_err(|_| Status::InvalidConfiguration)?;
        server
            .validate()
            .map_err(|_| Status::InvalidConfiguration)?;
        let mut values = BTreeMap::new();
        for (key, source) in server.values() {
            let value = match source {
                ValueSource::Literal(value) => value.clone(),
                ValueSource::Environment(name) => {
                    std::env::var(name).map_err(|_| Status::InvalidConfiguration)?
                }
                ValueSource::Secret(reference) => self
                    .credentials
                    .get(&credentials::account(&path, name, reference))
                    .map_err(|_| Status::AuthenticationRequired)?
                    .ok_or(Status::AuthenticationRequired)?,
            };
            if value.contains('\0')
                || (value.is_empty() && !matches!(source, ValueSource::Literal(_)))
            {
                return Err(Status::InvalidConfiguration);
            }
            values.insert(key.clone(), value);
        }
        let authorization = if let Transport::Http {
            url,
            oauth: Some(config),
            ..
        } = &server.transport
        {
            Some(
                self.authorizations
                    .entry(&path, name, url, config, self.credentials.clone())
                    .map_err(|_| Status::AuthenticationRequired)?,
            )
        } else {
            None
        };
        Ok(Prepared {
            server,
            values,
            folder,
            authorization,
        })
    }
    pub(super) async fn run_check(
        &self,
        prepared: Prepared,
        cancel: CancellationToken,
        limit: Duration,
    ) -> CheckResult {
        let result = match &prepared.server.transport {
            Transport::Stdio { command, args, .. } => {
                let path = prepared
                    .values
                    .get("PATH")
                    .map(std::ffi::OsString::from)
                    .or_else(|| std::env::var_os("PATH"));
                let Some(program) = executable(command, &prepared.folder, path.as_deref()) else {
                    return CheckResult::failed(Status::ExecutionFailed);
                };
                let mut command = tokio::process::Command::new(program);
                command
                    .args(args)
                    .envs(&prepared.values)
                    .current_dir(&prepared.folder)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .kill_on_drop(true);
                let Ok((mut child, mut group)) = crate::agent_runtime::spawn_process(&mut command)
                else {
                    return CheckResult::failed(Status::ExecutionFailed);
                };
                let result = if let (Some(input), Some(output)) =
                    (child.stdin.take(), child.stdout.take())
                {
                    let transport =
                        rmcp::transport::async_rw::AsyncRwTransport::new_client(output, input);
                    discover(transport, Status::ExecutionFailed, &cancel, limit).await
                } else {
                    CheckResult::failed(Status::ExecutionFailed)
                };
                group.kill();
                let _ = child.kill().await;
                let _ = child.wait().await;
                result
            }
            Transport::Http { url, .. } => {
                let mut relay_lease = None;
                let mut endpoint = url.clone();
                let mut values = prepared.values.clone();
                if let Some(auth) = prepared.authorization {
                    let deadline = tokio::time::Instant::now() + limit;
                    let result = until(
                        super::relay::Lease::start(
                            "check",
                            auth,
                            values.into_iter().collect(),
                            true,
                            &self.executable,
                        ),
                        &cancel,
                        deadline,
                    )
                    .await;
                    match result {
                        Ok(Ok((McpServer::Http(server), lease))) => {
                            endpoint = server.url;
                            values = server
                                .headers
                                .into_iter()
                                .map(|header| (header.name, header.value))
                                .collect();
                            relay_lease = Some(lease);
                        }
                        Err(status) => return CheckResult::failed(status),
                        _ => return CheckResult::failed(Status::AuthenticationRequired),
                    }
                }
                let _relay_lease = relay_lease;
                let mut headers = reqwest::header::HeaderMap::new();
                for (key, value) in &values {
                    let (Ok(key), Ok(mut value)) = (
                        reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                        reqwest::header::HeaderValue::from_str(value),
                    ) else {
                        return CheckResult::failed(Status::InvalidConfiguration);
                    };
                    value.set_sensitive(true);
                    headers.insert(key, value);
                }
                let Ok(client) = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .default_headers(headers)
                    .timeout(limit)
                    .build()
                else {
                    return CheckResult::failed(Status::NetworkError);
                };
                let config = StreamableHttpClientTransportConfig::with_uri(endpoint)
                    .control_request_timeout(Duration::from_secs(2));
                let transport = StreamableHttpClientTransport::with_client(client, config);
                discover(transport, Status::NetworkError, &cancel, limit).await
            }
        };
        result
    }
}
async fn until<F: std::future::Future>(
    future: F,
    cancel: &CancellationToken,
    deadline: tokio::time::Instant,
) -> Result<F::Output, Status> {
    tokio::select! { biased; _ = cancel.cancelled() => Err(Status::Cancelled), _ = tokio::time::sleep_until(deadline) => Err(Status::Timeout), result = future => Ok(result) }
}
fn transport_status(error: &rmcp::transport::DynamicTransportError, fallback: Status) -> Status {
    use rmcp::transport::streamable_http_client::StreamableHttpError;
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error.error.as_ref());
    while let Some(current) = source {
        if let Some(error) = current.downcast_ref::<StreamableHttpError<reqwest::Error>>() {
            match error {
                StreamableHttpError::AuthRequired(_)
                | StreamableHttpError::InsufficientScope(_) => {
                    return Status::AuthenticationRequired
                }
                StreamableHttpError::Client(error)
                    if error
                        .status()
                        .is_some_and(|status| matches!(status.as_u16(), 401 | 403)) =>
                {
                    return Status::AuthenticationRequired
                }
                StreamableHttpError::Client(error) if error.is_timeout() => return Status::Timeout,
                // rmcp retains an unchallenged 401/403 as a status-prefixed response error.
                StreamableHttpError::UnexpectedServerResponse(message)
                    if message.starts_with("HTTP 401 ") || message.starts_with("HTTP 403 ") =>
                {
                    return Status::AuthenticationRequired
                }
                _ => {}
            }
        }
        source = current.source();
    }
    fallback
}
async fn discover<T, E, A>(
    transport: T,
    fallback: Status,
    cancel: &CancellationToken,
    limit: Duration,
) -> CheckResult
where
    T: rmcp::transport::IntoTransport<RoleClient, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    let (transport, closed) = transport::ClosingTransport::new(transport.into_transport());
    let result = inspect(
        transport,
        fallback,
        cancel,
        tokio::time::Instant::now() + limit,
    )
    .await;
    // Initialization can fail or be cancelled before a RunningService exists.
    // Its transport still owns and awaits the HTTP session's DELETE path.
    let _ = tokio::time::timeout(Duration::from_secs(6), closed).await;
    result
}
async fn inspect<T: rmcp::transport::Transport<RoleClient> + 'static>(
    transport: T,
    fallback: Status,
    cancel: &CancellationToken,
    deadline: tokio::time::Instant,
) -> CheckResult {
    let service: RunningService<RoleClient, ()> =
        match until(().serve(transport), cancel, deadline).await {
            Err(status) => return CheckResult::failed(status),
            Ok(Ok(service)) => service,
            Ok(Err(error)) => {
                let status = if error.is_authorization_required() {
                    Status::AuthenticationRequired
                } else {
                    match error {
                        rmcp::service::ClientInitializeError::TransportError { error, .. } => {
                            transport_status(&error, fallback)
                        }
                        rmcp::service::ClientInitializeError::ConnectionClosed(_) => fallback,
                        _ => Status::ProtocolError,
                    }
                };
                return CheckResult::failed(status);
            }
        };
    let result = if service
        .peer_info()
        .is_some_and(|info| info.capabilities.tools.is_none())
    {
        CheckResult::failed(Status::NoTools)
    } else {
        match until(service.list_all_tools(), cancel, deadline).await {
            Err(status) => CheckResult::failed(status),
            Ok(Ok(tools)) => CheckResult {
                status: if tools.is_empty() {
                    Status::NoTools
                } else {
                    Status::Connected
                },
                tools: tools
                    .into_iter()
                    .map(|tool| tool.name.to_string())
                    .collect(),
            },
            Ok(Err(rmcp::ServiceError::TransportSend(error))) => {
                CheckResult::failed(transport_status(&error, fallback))
            }
            Ok(Err(_)) => CheckResult::failed(Status::ProtocolError),
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(6), service.cancel()).await;
    result
}
#[tauri::command]
pub(crate) async fn check_mcp(
    app: AppHandle,
    target: Target,
    name: String,
    id: Uuid,
) -> Result<CheckResult, String> {
    let service = app.state::<Arc<Mcp>>().inner().clone();
    let folder = match &target {
        Target::Global => app
            .path()
            .home_dir()
            .map_err(|_| "Home directory unavailable")?,
        Target::Project { folder } => folder.clone(),
    };
    let cancel = CancellationToken::new();
    {
        let mut checks = service
            .checks
            .0
            .lock()
            .map_err(|_| "Connection checks unavailable")?;
        if checks.contains_key(&id) || checks.len() >= 16 {
            return Err("A check is already running; cancel it and retry".into());
        }
        checks.insert(id, cancel.clone());
    }
    let prepare = service.clone();
    let result = match tauri::async_runtime::spawn_blocking(move || {
        prepare.prepare_check(&target, &name, folder)
    })
    .await
    {
        Ok(Ok(prepared)) => {
            service
                .run_check(prepared, cancel, Duration::from_secs(20))
                .await
        }
        Ok(Err(status)) => CheckResult::failed(status),
        Err(_) => CheckResult::failed(Status::InvalidConfiguration),
    };
    if let Ok(mut checks) = service.checks.0.lock() {
        checks.remove(&id);
    }
    Ok(result)
}
#[tauri::command]
pub(crate) fn cancel_mcp_check(service: State<'_, Arc<Mcp>>, id: Uuid) {
    if let Ok(checks) = service.checks.0.lock() {
        if let Some(cancel) = checks.get(&id) {
            cancel.cancel();
        }
    }
}
