//! Atte-owned authorization; the SDK owns discovery, PKCE, issuer checks and refresh.
use super::*;
use model::OAuthConfig;
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationRequest, AuthorizationSession, CredentialStore,
    StoredCredentials,
};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

pub(super) fn validate_url(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid OAuth server URL")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("OAuth requires HTTPS or a loopback HTTP URL without credentials".into());
    }
    Ok(())
}
#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Required,
    SigningIn,
    Authorized,
    ReauthorizationRequired,
}

#[derive(Default)]
pub(super) struct Authorizations(Mutex<BTreeMap<String, Arc<Authorization>>>);
pub(super) struct Authorization {
    pub url: String,
    owner: String,
    config: OAuthConfig,
    store: Store,
    manager: AsyncMutex<Option<AuthorizationManager>>,
    status: Mutex<Status>,
    login: Mutex<Option<CancellationToken>>,
    revocation: Mutex<CancellationToken>,
    challenge: Mutex<Option<String>>,
}
#[derive(Clone)]
struct Store {
    credentials: Arc<dyn Credentials>,
    account: String,
    // Blocking keychain work may outlive a cancelled async operation. A generation
    // checked while holding this gate prevents a late write after logout/cancel.
    generation: Arc<Mutex<u64>>,
}
#[async_trait::async_trait]
impl CredentialStore for Store {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            store
                .credentials
                .get(&store.account)
                .map_err(|_| storage_error())?
                .map(|value| serde_json::from_str(&value).map_err(|_| storage_error()))
                .transpose()
        })
        .await
        .map_err(|_| storage_error())?
    }
    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        // All manager operations and logout share Authorization::manager.
        let store = self.clone();
        let generation = *self.generation.lock().map_err(|_| storage_error())?;
        tokio::task::spawn_blocking(move || {
            let current = store.generation.lock().map_err(|_| storage_error())?;
            if *current != generation {
                return Err(storage_error());
            }
            let value = serde_json::to_string(&credentials).map_err(|_| storage_error())?;
            store
                .credentials
                .set(&store.account, &value)
                .map_err(|_| storage_error())
        })
        .await
        .map_err(|_| storage_error())?
    }
    async fn clear(&self) -> Result<(), AuthError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = store.generation.lock().map_err(|_| storage_error())?;
            store
                .credentials
                .delete(&store.account)
                .map_err(|_| storage_error())
        })
        .await
        .map_err(|_| storage_error())?
    }
}
fn storage_error() -> AuthError {
    AuthError::CredentialStoreError("OS credential store unavailable".into())
}
impl Authorizations {
    pub fn entry(
        &self,
        path: &Path,
        name: &str,
        url: &str,
        config: &OAuthConfig,
        credentials: Arc<dyn Credentials>,
    ) -> Result<Arc<Authorization>, String> {
        validate_url(url)?;
        let identity =
            serde_json::to_string(&(url, config)).map_err(|_| "Invalid OAuth configuration")?;
        let account = credentials::account(path, name, &format!("oauth:{identity}"));
        let mut entries = self.0.lock().map_err(|_| "OAuth unavailable")?;
        if let Some(entry) = entries.get(&account) {
            return Ok(entry.clone());
        }
        let saved = credentials.get(&account)?;
        let status = if saved.is_some() {
            Status::Authorized
        } else {
            Status::Required
        };
        let entry = Arc::new(Authorization {
            url: url.into(),
            owner: credentials::account(path, name, "oauth-owner"),
            config: config.clone(),
            store: Store {
                credentials,
                account: account.clone(),
                generation: Arc::new(Mutex::new(0)),
            },
            manager: AsyncMutex::new(None),
            status: Mutex::new(status),
            login: Mutex::new(None),
            revocation: Mutex::new(CancellationToken::new()),
            challenge: Mutex::new(None),
        });
        entries.insert(account, entry.clone());
        Ok(entry)
    }
}
impl Authorizations {
    fn for_server(&self, path: &Path, name: &str) -> Result<Vec<Arc<Authorization>>, String> {
        let owner = credentials::account(path, name, "oauth-owner");
        Ok(self
            .0
            .lock()
            .map_err(|_| "OAuth unavailable")?
            .values()
            .filter(|entry| entry.owner == owner)
            .cloned()
            .collect())
    }
    pub fn cancel_logins(&self, path: &Path, name: &str) -> Result<(), String> {
        for entry in self.for_server(path, name)? {
            entry.cancel();
        }
        Ok(())
    }
}
impl Authorization {
    pub fn status(&self) -> Status {
        self.status.lock().map(|s| *s).unwrap_or(Status::Required)
    }
    fn set_status(&self, status: Status) {
        if let Ok(mut s) = self.status.lock() {
            *s = status;
        }
    }
    pub fn revocation(&self) -> Result<CancellationToken, String> {
        self.revocation
            .lock()
            .map(|c| c.clone())
            .map_err(|_| "OAuth unavailable".into())
    }
    pub fn cancel(&self) {
        if let Ok(login) = self.login.lock() {
            if let Some(cancel) = login.as_ref() {
                cancel.cancel();
            }
        }
    }
    pub async fn logout(&self) -> Result<(), String> {
        self.cancel();
        self.revocation()?.cancel();
        self.set_status(Status::Required);
        self.invalidate_writes()?;
        let mut manager = self.manager.lock().await;
        *manager = None;
        self.invalidate_writes()?;
        self.revocation()?.cancel();
        self.set_status(Status::Required);
        self.store.clear().await.map_err(|_| {
            "Cannot delete OAuth credentials; unlock the OS credential store and retry".to_string()
        })
    }
    fn invalidate_writes(&self) -> Result<(), String> {
        let mut generation = self
            .store
            .generation
            .lock()
            .map_err(|_| "OAuth unavailable")?;
        *generation = generation.wrapping_add(1);
        Ok(())
    }
    async fn new_manager(&self) -> Result<AuthorizationManager, String> {
        let mut manager = AuthorizationManager::new(&self.url)
            .await
            .map_err(|_| "OAuth discovery failed; check the server and network")?;
        manager.set_credential_store(self.store.clone());
        let challenge = self
            .challenge
            .lock()
            .map_err(|_| "OAuth unavailable")?
            .clone();
        let metadata = manager
            .resolve_metadata_from_challenge(challenge.as_deref())
            .await
            .map_err(|_| "OAuth metadata discovery failed")?;
        manager.set_metadata(metadata.metadata);
        Ok(manager)
    }
    pub async fn token(&self) -> Result<String, String> {
        let mut manager = self.manager.lock().await;
        if self.status() != Status::Authorized {
            return Err("Sign in to this MCP server".into());
        }
        if manager.is_none() {
            let mut restored = self.new_manager().await?;
            if !restored
                .initialize_from_store()
                .await
                .map_err(|_| "Cannot restore OAuth credentials")?
            {
                self.set_status(Status::ReauthorizationRequired);
                return Err("Sign in again to this MCP server".into());
            }
            *manager = Some(restored);
        }
        let Some(manager) = manager.as_ref() else {
            return Err("OAuth unavailable".into());
        };
        match manager.get_access_token().await {
            Ok(token) => Ok(token),
            Err(AuthError::AuthorizationRequired | AuthError::TokenRefreshRejected(_)) => {
                self.set_status(Status::ReauthorizationRequired);
                Err("Sign in again to this MCP server".into())
            }
            Err(_) => Err("OAuth refresh failed; check the network and credential store".into()),
        }
    }
    pub fn require_login(&self, challenge: Option<String>) {
        if let Ok(mut saved) = self.challenge.lock() {
            *saved = challenge;
        }
        self.set_status(Status::ReauthorizationRequired);
    }
    pub async fn login(&self, open: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
        let cancel = CancellationToken::new();
        {
            let mut login = self.login.lock().map_err(|_| "OAuth unavailable")?;
            if login.is_some() {
                return Err("Sign-in is already in progress".into());
            }
            *login = Some(cancel.clone());
        }
        self.set_status(Status::SigningIn);
        // Do not drop a credential write on cancellation: logout waits for this guard.
        let mut manager = self.manager.lock().await;
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("Sign-in cancelled".into()),
            result = tokio::time::timeout(std::time::Duration::from_secs(300), self.authorize(open, &cancel)) =>
                result.unwrap_or_else(|_| Err("Sign-in timed out; retry".into())),
        };
        if let Ok(mut login) = self.login.lock() {
            *login = None;
        }
        match result {
            Ok(session) => {
                *manager = Some(session.auth_manager);
                let mut revocation = self.revocation.lock().map_err(|_| "OAuth unavailable")?;
                revocation.cancel();
                *revocation = CancellationToken::new();
                self.set_status(Status::Authorized);
                Ok(())
            }
            Err(error) => {
                self.invalidate_writes()?;
                *manager = None;
                self.set_status(Status::Required);
                // An interrupted exchange must not leave a newly persisted session.
                self.store
                    .clear()
                    .await
                    .map_err(|_| "Cannot clear interrupted OAuth session")?;
                Err(error)
            }
        }
    }
    async fn authorize(
        &self,
        open: impl FnOnce(&str) -> Result<(), String>,
        cancel: &CancellationToken,
    ) -> Result<AuthorizationSession, String> {
        use axum::{
            extract::{OriginalUri, State},
            http::StatusCode,
            routing::get,
            Router,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "Cannot open OAuth callback")?;
        let address = listener
            .local_addr()
            .map_err(|_| "Cannot open OAuth callback")?;
        let redirect = format!("http://{address}/callback");
        let manager = self.new_manager().await?;
        let mut request = AuthorizationRequest::new(&redirect)
            .with_client_name("Atte")
            .with_application_type("native")
            .with_initial_scope_selection();
        if let Some(id) = &self.config.client_id {
            request = request.with_preregistered_client(id);
        }
        let session = AuthorizationSession::new(manager, request)
            .await
            .map_err(|_| "OAuth client registration failed; configure a client ID if required")?;
        let (send, mut receive) = tokio::sync::mpsc::channel::<String>(1);
        let router = Router::new()
            .route(
                "/callback",
                get(
                    |State(send): State<tokio::sync::mpsc::Sender<String>>,
                     OriginalUri(uri): OriginalUri| async move {
                        if send.try_send(uri.to_string()).is_ok() {
                            (StatusCode::OK, "Return to Atte to complete sign-in.")
                        } else {
                            (StatusCode::BAD_REQUEST, "Callback already received.")
                        }
                    },
                ),
            )
            .with_state(send);
        let stop = cancel.child_token();
        let stopped = stop.clone();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(stopped.cancelled_owned())
                .await;
        });
        struct CallbackTask(tokio::task::JoinHandle<()>);
        impl Drop for CallbackTask {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let _task = CallbackTask(task);
        open(session.get_authorization_url())?;
        let uri = receive.recv().await.ok_or("OAuth callback closed")?;
        let callback = format!("http://{address}{uri}");
        session
            .handle_callback_url(&callback)
            .await
            .map_err(|_| "OAuth callback validation or token exchange failed; retry sign-in")?;
        stop.cancel();
        Ok(session)
    }
}
impl Mcp {
    pub(crate) async fn logout(
        self: &Arc<Self>,
        target: &Target,
        name: &str,
    ) -> Result<(), String> {
        let service = self.clone();
        let target = target.clone();
        let name = name.to_string();
        let entries = tokio::task::spawn_blocking(move || {
            // Include the persisted current identity even after a restart. Existing
            // connections may still own older settings until their next reconnect.
            service.authorization(&target, &name)?;
            service
                .authorizations
                .for_server(&service.path(&target)?, &name)
        })
        .await
        .map_err(|_| "OAuth unavailable")??;
        // Revoke every connection before awaiting any keychain operation.
        for entry in &entries {
            entry.cancel();
            entry.revocation()?.cancel();
            entry.set_status(Status::Required);
        }
        let mut error = None;
        for entry in entries {
            if let Err(failure) = entry.logout().await {
                error = Some(failure);
            }
        }
        error.map_or(Ok(()), Err)
    }
    pub(super) fn authorization(
        &self,
        target: &Target,
        name: &str,
    ) -> Result<Arc<Authorization>, String> {
        let path = self.path(target)?;
        let server: Server = serde_json::from_value(
            self.read(target)?
                .remove(name)
                .ok_or("Server no longer exists")?,
        )
        .map_err(|_| "Invalid MCP configuration")?;
        server.validate()?;
        match server.transport {
            Transport::Http {
                url,
                oauth: Some(config),
                ..
            } => self
                .authorizations
                .entry(&path, name, &url, &config, self.credentials.clone()),
            _ => Err("Enable OAuth for this HTTP server first".into()),
        }
    }
}
#[tauri::command]
pub(crate) async fn login_mcp(app: AppHandle, target: Target, name: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let service = app.state::<Arc<Mcp>>().inner().clone();
    let auth = tokio::task::spawn_blocking(move || service.authorization(&target, &name))
        .await
        .map_err(|_| "OAuth unavailable")??;
    auth.login(|url| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "Cannot open system browser".into())
    })
    .await
}
#[tauri::command]
pub(crate) async fn cancel_mcp_login(
    app: AppHandle,
    target: Target,
    name: String,
) -> Result<(), String> {
    let service = app.state::<Arc<Mcp>>().inner().clone();
    tokio::task::spawn_blocking(move || {
        service.authorization(&target, &name)?.cancel();
        Ok(())
    })
    .await
    .map_err(|_| "OAuth unavailable")?
}
#[tauri::command]
pub(crate) async fn logout_mcp(app: AppHandle, target: Target, name: String) -> Result<(), String> {
    let service = app.state::<Arc<Mcp>>().inner().clone();
    service.logout(&target, &name).await
}
