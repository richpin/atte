//! Real OAuth/PKCE and MCP peers at the authorization and transport boundaries.
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Request, Response, StatusCode},
    routing::any,
    Router,
};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

pub struct Peer {
    pub url: String,
    pub state: Arc<PeerState>,
    task: tokio::task::JoinHandle<()>,
}
pub struct PeerState {
    origin: String,
    codes: Mutex<BTreeMap<String, String>>,
    pub registrations: AtomicUsize,
    pub refreshes: AtomicUsize,
    pub reject_refresh: AtomicBool,
    pub short_token: AtomicBool,
    pub sessions: Mutex<BTreeMap<String, usize>>,
    pub calls: AtomicUsize,
    pub deletions: AtomicUsize,
    pub notifications: AtomicUsize,
    pub stream: AtomicBool,
    pub issuer_changed: AtomicBool,
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Peer {
    pub async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(PeerState {
            origin: origin.clone(),
            codes: Mutex::default(),
            registrations: AtomicUsize::new(0),
            refreshes: AtomicUsize::new(0),
            reject_refresh: AtomicBool::new(false),
            short_token: AtomicBool::new(false),
            sessions: Mutex::default(),
            calls: AtomicUsize::new(0),
            deletions: AtomicUsize::new(0),
            notifications: AtomicUsize::new(0),
            stream: AtomicBool::new(false),
            issuer_changed: AtomicBool::new(false),
        });
        let router = Router::new()
            .fallback(any(handle))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            url: format!("{origin}/mcp"),
            state,
            task,
        }
    }
    pub fn browser(&self, url: &str, invalid: Option<&str>) -> Result<(), String> {
        let url = reqwest::Url::parse(url).unwrap();
        assert_eq!(url.path(), "/authorize");
        let query: BTreeMap<_, _> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["resource"], self.url);
        let code = Uuid::new_v4().to_string();
        self.state
            .codes
            .lock()
            .unwrap()
            .insert(code.clone(), query["code_challenge"].clone());
        let mut callback = reqwest::Url::parse(&query["redirect_uri"]).unwrap();
        callback
            .query_pairs_mut()
            .append_pair("code", &code)
            .append_pair(
                "state",
                if invalid == Some("state") {
                    "wrong"
                } else {
                    &query["state"]
                },
            )
            .append_pair(
                "iss",
                if invalid == Some("issuer") {
                    "https://other.invalid"
                } else {
                    &self.state.origin
                },
            );
        tokio::spawn(async move {
            let _ = reqwest::get(callback).await;
        });
        Ok(())
    }
}
fn response(status: StatusCode, value: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&value).unwrap()))
        .unwrap()
}
async fn handle(State(state): State<Arc<PeerState>>, request: Request<Body>) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, 1024 * 1024).await.unwrap();
    let path = parts.uri.path();
    if path.starts_with("/.well-known/oauth-protected-resource") {
        return response(
            StatusCode::OK,
            json!({"resource":format!("{}/mcp",state.origin),"authorization_servers":[state.origin],"scopes_supported":["read"]}),
        );
    }
    if path.starts_with("/.well-known/") {
        return response(
            StatusCode::OK,
            json!({"issuer":if state.issuer_changed.load(Ordering::SeqCst) { format!("{}/different-issuer",state.origin) } else { state.origin.clone() },"authorization_endpoint":format!("{}/authorize",state.origin),"token_endpoint":format!("{}/token",state.origin),"registration_endpoint":format!("{}/register",state.origin),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],"scopes_supported":["read"]}),
        );
    }
    if path == "/authorize" {
        let url = reqwest::Url::parse(&format!("{}{}", state.origin, parts.uri)).unwrap();
        let query: BTreeMap<_, _> = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        let code = Uuid::new_v4().to_string();
        state
            .codes
            .lock()
            .unwrap()
            .insert(code.clone(), query["code_challenge"].clone());
        let mut callback = reqwest::Url::parse(&query["redirect_uri"]).unwrap();
        callback
            .query_pairs_mut()
            .append_pair("code", &code)
            .append_pair("state", &query["state"])
            .append_pair("iss", &state.origin);
        return Response::builder()
            .status(302)
            .header("location", callback.as_str())
            .body(Body::empty())
            .unwrap();
    }
    if path == "/register" {
        state.registrations.fetch_add(1, Ordering::SeqCst);
        let registration: Value = serde_json::from_slice(&bytes).unwrap();
        return response(
            StatusCode::CREATED,
            json!({"client_id":"atte-fixture","redirect_uris":registration["redirect_uris"],"token_endpoint_auth_method":"none"}),
        );
    }
    if path == "/token" {
        let form: BTreeMap<String, String> = reqwest::Url::parse(&format!(
            "http://localhost/?{}",
            String::from_utf8(bytes.to_vec()).unwrap()
        ))
        .unwrap()
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
        assert_eq!(form["resource"], format!("{}/mcp", state.origin));
        let refresh = form["grant_type"] == "refresh_token";
        if refresh {
            state.refreshes.fetch_add(1, Ordering::SeqCst);
            if state.reject_refresh.load(Ordering::SeqCst) {
                return response(StatusCode::BAD_REQUEST, json!({"error":"invalid_grant"}));
            }
            assert_eq!(form["refresh_token"], "fixture-refresh-1");
        } else {
            let challenge = state.codes.lock().unwrap().remove(&form["code"]).unwrap();
            assert_eq!(
                challenge,
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(Sha256::digest(form["code_verifier"].as_bytes()))
            );
        }
        return response(
            StatusCode::OK,
            json!({"access_token":if refresh {"fixture-access-2"} else {"fixture-access-1"},"token_type":"Bearer","refresh_token":if refresh {"fixture-refresh-2"} else {"fixture-refresh-1"},"expires_in":if !refresh && state.short_token.load(Ordering::SeqCst) {1} else {3600},"scope":"read"}),
        );
    }
    if path != "/mcp" {
        return response(StatusCode::NOT_FOUND, json!({}));
    }
    if !parts.headers.get("authorization").is_some_and(|value| {
        value == "Bearer fixture-access-1" || value == "Bearer fixture-access-2"
    }) {
        return Response::builder()
            .status(401)
            .header(
                "www-authenticate",
                format!(
                    "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\"",
                    state.origin
                ),
            )
            .body(Body::empty())
            .unwrap();
    }
    if parts.method == axum::http::Method::GET {
        if state.stream.load(Ordering::SeqCst) {
            use futures_util::StreamExt;
            let stream = futures_util::stream::once(async { Ok::<_, std::io::Error>("event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n") }).chain(futures_util::stream::pending());
            return Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(stream))
                .unwrap();
        }
        return response(StatusCode::METHOD_NOT_ALLOWED, json!({}));
    }
    if parts.method == axum::http::Method::DELETE {
        if let Some(id) = parts.headers.get("mcp-session-id") {
            state.sessions.lock().unwrap().remove(id.to_str().unwrap());
        }
        state.deletions.fetch_add(1, Ordering::SeqCst);
        return Response::builder().status(204).body(Body::empty()).unwrap();
    }
    let message: Value = serde_json::from_slice(&bytes).unwrap();
    if message.get("id").is_none() {
        state.notifications.fetch_add(1, Ordering::SeqCst);
        return Response::builder().status(202).body(Body::empty()).unwrap();
    }
    let mut session_id = None;
    let result = match message["method"].as_str().unwrap() {
        "initialize" => {
            let id = Uuid::new_v4().to_string();
            state.sessions.lock().unwrap().insert(id.clone(), 0);
            session_id = Some(id);
            json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"oauth-fixture","version":"1"}})
        }
        "tools/list" => json!({"tools":[{"name":"where","inputSchema":{"type":"object"}}]}),
        "tools/call" => {
            let id = parts
                .headers
                .get("mcp-session-id")
                .unwrap()
                .to_str()
                .unwrap();
            let mut sessions = state.sessions.lock().unwrap();
            let calls = sessions.get_mut(id).unwrap();
            *calls += 1;
            state.calls.fetch_add(1, Ordering::SeqCst);
            json!({"content":[{"type":"text","text":format!("OAuth MCP tool result: {calls}")}],"isError":false})
        }
        _ => json!({}),
    };
    let mut response = response(
        StatusCode::OK,
        json!({"jsonrpc":"2.0","id":message["id"],"result":result}),
    );
    if let Some(id) = session_id {
        response
            .headers_mut()
            .insert("mcp-session-id", id.parse().unwrap());
    }
    response
}

#[cfg(not(test))]
#[tokio::main]
async fn main() {
    let peer = Peer::start().await;
    println!("{}", peer.url);
    std::future::pending::<()>().await;
}
