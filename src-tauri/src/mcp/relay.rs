//! Byte-preserving Streamable HTTP relay, scoped to one ACP connection and server.
use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{Request, Response, StatusCode},
    routing::{any, get},
    Router,
};
use tokio_util::sync::CancellationToken;

pub(crate) struct Lease {
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    upstream: Arc<Upstream>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.task.abort();
        let upstream = self.upstream.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ =
                    tokio::time::timeout(std::time::Duration::from_secs(3), upstream.close()).await;
            });
        }
    }
}
struct Upstream {
    auth: Arc<oauth::Authorization>,
    client: reqwest::Client,
    headers: reqwest::header::HeaderMap,
    credential: String,
    cancel: CancellationToken,
    revoked: CancellationToken,
    sessions: Mutex<BTreeMap<String, reqwest::header::HeaderMap>>,
}
impl Lease {
    pub(super) async fn start(
        name: &str,
        auth: Arc<oauth::Authorization>,
        headers: Vec<(String, String)>,
        http: bool,
        executable: &Path,
    ) -> Result<(McpServer, Self), String> {
        // Validate restored issuer and credential storage before handing anything to an agent.
        auth.token().await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "Cannot open MCP relay")?;
        let address = listener.local_addr().map_err(|_| "Cannot open MCP relay")?;
        let url = format!("http://{address}/mcp");
        let credential = Uuid::new_v4().to_string();
        let mut upstream_headers = reqwest::header::HeaderMap::new();
        for (name, value) in headers {
            let key = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "Invalid header name")?;
            if !hop_header(key.as_str()) && key != reqwest::header::AUTHORIZATION {
                let mut value = reqwest::header::HeaderValue::from_str(&value)
                    .map_err(|_| "Invalid header value")?;
                value.set_sensitive(true);
                upstream_headers.insert(key, value);
            }
        }
        let cancel = CancellationToken::new();
        let revoked = auth.revocation()?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|_| "Cannot create MCP relay")?;
        let upstream = Arc::new(Upstream {
            auth,
            client,
            headers: upstream_headers,
            credential: format!("Bearer {credential}"),
            cancel: cancel.clone(),
            revoked: revoked.clone(),
            sessions: Mutex::new(BTreeMap::new()),
        });
        let router = Router::new()
            .route("/mcp", any(forward))
            .route("/lease", get(watch))
            .with_state(upstream.clone());
        let stopped = cancel.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                _ = stopped.cancelled() => {},
                _ = revoked.cancelled() => {},
                _ = axum::serve(listener, router) => {},
            }
        });
        let server = if http {
            McpServer::Http(McpServerHttp::new(name, url).headers(vec![HttpHeader::new(
                "Authorization",
                format!("Bearer {credential}"),
            )]))
        } else {
            McpServer::Stdio(
                McpServerStdio::new(name, executable)
                    .args(vec!["--mcp-stdio-bridge".into(), url])
                    .env(vec![EnvVariable::new("ATTE_MCP_RELAY_TOKEN", credential)]),
            )
        };
        Ok((
            server,
            Self {
                cancel,
                task,
                upstream,
            },
        ))
    }
}
impl Upstream {
    async fn close(&self) {
        if self.revoked.is_cancelled() {
            return;
        }
        let sessions = self
            .sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        if sessions.is_empty() {
            return;
        }
        if let Ok(token) = self.auth.token().await {
            for headers in sessions {
                let _ = self
                    .client
                    .delete(&self.auth.url)
                    .headers(self.headers.clone())
                    .headers(headers)
                    .bearer_auth(&token)
                    .send()
                    .await;
            }
        }
    }
}
fn hop_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "connection"
            | "keep-alive"
            | "transfer-encoding"
            | "te"
            | "trailer"
            | "upgrade"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "content-length"
    )
}
async fn watch(
    State(upstream): State<Arc<Upstream>>,
    request: Request<Body>,
) -> Result<Response<Body>, StatusCode> {
    use futures_util::StreamExt;
    if request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some(&upstream.credential)
        || request.headers().contains_key("origin")
        || upstream.cancel.is_cancelled()
        || upstream.revoked.is_cancelled()
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let lifetime = futures_util::stream::once(async { Ok::<_, std::io::Error>(vec![b'.']) })
        .chain(futures_util::stream::once(async move {
            tokio::select! { _ = upstream.cancel.cancelled() => {}, _ = upstream.revoked.cancelled() => {} }
            Ok::<_, std::io::Error>(Vec::new())
        }));
    Ok(Response::new(Body::from_stream(lifetime)))
}
async fn forward(
    State(upstream): State<Arc<Upstream>>,
    request: Request<Body>,
) -> Result<Response<Body>, StatusCode> {
    if upstream.cancel.is_cancelled() || upstream.revoked.is_cancelled() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        != Some(&upstream.credential)
        || request.headers().contains_key("origin")
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if !matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::POST | axum::http::Method::DELETE
    ) {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    let (parts, body) = request.into_parts();
    let session_id = parts
        .headers
        .get("mcp-session-id")
        .map(|value| value.to_str().map(str::to_owned))
        .transpose()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if let Some(id) = &session_id {
        let mut sessions = upstream
            .sessions
            .lock()
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let session = sessions.get_mut(id).ok_or(StatusCode::NOT_FOUND)?;
        if let Some(version) = parts.headers.get("mcp-protocol-version") {
            session.insert("mcp-protocol-version", version.clone());
        }
    }
    let work = async {
        let token = upstream
            .auth
            .token()
            .await
            .map_err(|_| StatusCode::UNAUTHORIZED)?;
        let mut headers = upstream.headers.clone();
        for (name, value) in &parts.headers {
            if !hop_header(name.as_str()) && name != "authorization" && name != "cookie" {
                headers.insert(name.clone(), value.clone());
            }
        }
        let deleting = parts.method == axum::http::Method::DELETE;
        let response = upstream
            .client
            .request(parts.method, &upstream.auth.url)
            .headers(headers)
            .bearer_auth(token)
            .body(reqwest::Body::wrap_stream(body.into_data_stream()))
            .send()
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            upstream.auth.require_login(
                response
                    .headers()
                    .get("www-authenticate")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned),
            );
            return Err(StatusCode::UNAUTHORIZED);
        }
        if let Ok(mut sessions) = upstream.sessions.lock() {
            if deleting && response.status().is_success() {
                if let Some(id) = &session_id {
                    sessions.remove(id);
                }
            } else if let Some(id) = response.headers().get("mcp-session-id") {
                let id_text = id.to_str().map_err(|_| StatusCode::BAD_GATEWAY)?;
                let session = sessions.entry(id_text.to_string()).or_default();
                session.insert("mcp-session-id", id.clone());
                if let Some(version) = parts.headers.get("mcp-protocol-version") {
                    session.insert("mcp-protocol-version", version.clone());
                }
            }
        }
        let mut builder = Response::builder().status(response.status());
        for (name, value) in response.headers() {
            if !hop_header(name.as_str())
                && name != "set-cookie"
                && name != "www-authenticate"
                && name != "location"
            {
                builder = builder.header(name, value);
            }
        }
        let cancel = upstream.cancel.clone();
        let revoked = upstream.revoked.clone();
        let stream = futures_util::stream::unfold(
            (response.bytes_stream(), cancel, revoked),
            |(mut stream, cancel, revoked)| async move {
                use futures_util::StreamExt;
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => None,
                    _ = revoked.cancelled() => None,
                    chunk = stream.next() => chunk.map(|chunk| (chunk, (stream, cancel, revoked))),
                }
            },
        );
        builder
            .body(Body::from_stream(stream))
            .map_err(|_| StatusCode::BAD_GATEWAY)
    };
    tokio::select! {
        biased;
        _ = upstream.cancel.cancelled() => Err(StatusCode::UNAUTHORIZED),
        _ = upstream.revoked.cancelled() => Err(StatusCode::UNAUTHORIZED),
        result = work => result,
    }
}

impl Mcp {
    pub(crate) async fn resolve_session(
        self: &Arc<Self>,
        folder: PathBuf,
        working: PathBuf,
        http: bool,
        environment: Arc<BTreeMap<String, String>>,
    ) -> Result<(Vec<McpServer>, SessionState, Vec<Lease>), String> {
        let service = self.clone();
        let (mut servers, mut state, oauth) = tokio::task::spawn_blocking(move || {
            let _guard = service
                .lock
                .lock()
                .map_err(|_| "MCP settings unavailable")?;
            let combined = service.combined(&folder)?;
            let (servers, state) =
                service.resolve_configuration(&combined, &working, http, &environment)?;
            let mut oauth = Vec::new();
            for (name, (path, value)) in combined {
                let Ok(server) = serde_json::from_value::<Server>(value) else {
                    continue;
                };
                if !server.enabled {
                    continue;
                }
                if let Transport::Http {
                    url,
                    oauth: Some(config),
                    ..
                } = &server.transport
                {
                    let prepared = (|| {
                        server.validate()?;
                        let auth = service.authorizations.entry(
                            &path,
                            &name,
                            url,
                            config,
                            service.credentials.clone(),
                        )?;
                        let values = service.resolve_values(&server, &path, &name, &environment)?;
                        Ok((auth, values))
                    })();
                    oauth.push((name, prepared));
                }
            }
            Ok::<_, String>((servers, state, oauth))
        })
        .await
        .map_err(|_| "MCP configuration unavailable")??;
        let mut leases = vec![];
        for (name, prepared) in oauth {
            state.issues.retain(|issue| issue.name != name);
            let result = match prepared {
                Ok((auth, headers)) => tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    Lease::start(&name, auth, headers, http, &self.executable),
                )
                .await
                .unwrap_or_else(|_| Err("MCP authorization timed out; retry".into())),
                Err(error) => Err(error),
            };
            match result {
                Ok((server, lease)) => {
                    servers.push(server);
                    leases.push(lease);
                }
                Err(reason) => state.issues.push(Issue { name, reason }),
            }
        }
        Ok((servers, state, leases))
    }
}
