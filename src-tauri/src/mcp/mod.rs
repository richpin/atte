//! Scoped MCP configuration, credentials, and ACP forwarding.
mod credentials;
mod model;
use agent_client_protocol::schema::v1::{
    EnvVariable, HttpHeader, McpServer, McpServerHttp, McpServerStdio,
};
pub use credentials::{Credentials, NativeCredentials};
pub use model::{Server, Transport, ValueSource};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use uuid::Uuid;

#[derive(Clone, Deserialize)]
#[serde(tag = "scope", rename_all = "camelCase")]
pub enum Target {
    Global,
    Project { folder: PathBuf },
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub name: String,
    pub reason: String,
}
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub issues: Vec<Issue>,
    pub revision: String,
    pub reconnect_required: bool,
}
#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub servers: BTreeMap<String, Server>,
    pub issues: Vec<Issue>,
    pub error: Option<String>,
    pub path: PathBuf,
}

pub struct Mcp {
    global: Arc<Mutex<crate::settings::store::Store>>,
    global_path: PathBuf,
    credentials: Arc<dyn Credentials>,
    lock: Mutex<()>,
    snapshots: Mutex<BTreeMap<PathBuf, Snapshot>>,
}
impl Mcp {
    pub(crate) fn new(
        global: Arc<Mutex<crate::settings::store::Store>>,
        global_path: PathBuf,
        credentials: Arc<dyn Credentials>,
    ) -> Self {
        Self {
            global,
            global_path,
            credentials,
            lock: Mutex::new(()),
            snapshots: Mutex::new(BTreeMap::new()),
        }
    }
    fn path(&self, target: &Target) -> Result<PathBuf, String> {
        match target {
            Target::Global => Ok(self.global_path.clone()),
            Target::Project { folder } if folder.is_absolute() && folder.is_dir() => Ok(folder
                .canonicalize()
                .map_err(|_| "Project folder unavailable")?
                .join(".atte/mcp.json")),
            _ => Err("Select an existing absolute project folder".into()),
        }
    }
    fn read(&self, target: &Target) -> Result<Map<String, Value>, String> {
        if matches!(target, Target::Global) {
            return self
                .global
                .lock()
                .map_err(|_| "Settings unavailable")?
                .mcp_servers();
        }
        let path = self.path(target)?;
        let (_, document) = read_project(&path)?;
        Ok(document
            .get("mcpServers")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default())
    }
    pub fn snapshot(&self, target: &Target) -> Snapshot {
        let path = self.path(target).unwrap_or_default();
        let mut snapshot = Snapshot {
            servers: BTreeMap::new(),
            issues: vec![],
            error: None,
            path,
        };
        match self.read(target) {
            Err(_) => {
                snapshot.error = Some(
                    "Cannot read MCP configuration. Correct the settings file and retry.".into(),
                )
            }
            Ok(servers) => {
                for (name, value) in servers {
                    match serde_json::from_value::<Server>(value) {
                        Ok(server) => { snapshot.servers.insert(name, server); }
                        Err(_) => snapshot.issues.push(Issue { name, reason: "Unsupported or invalid server configuration; edit the settings file".into() }),
                    }
                }
            }
        }
        if let Ok(mut snapshots) = self.snapshots.lock() {
            if snapshot.error.is_some() {
                if let Some(previous) = snapshots.get(&snapshot.path) {
                    snapshot.servers = previous.servers.clone();
                    snapshot.issues = previous.issues.clone();
                }
            } else {
                snapshots.insert(snapshot.path.clone(), snapshot.clone());
            }
        }
        snapshot
    }
    pub fn save(
        &self,
        target: &Target,
        name: &str,
        mut server: Server,
        secrets: BTreeMap<String, String>,
        create: bool,
    ) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "MCP settings unavailable")?;
        if name.trim().is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
            return Err("Enter a server name of at most 128 characters".into());
        }
        server.validate()?;
        let path = self.path(target)?;
        let old = self.read(target)?;
        if create && old.contains_key(name) {
            return Err("A server with this name already exists in this scope".into());
        }
        if !create && !old.contains_key(name) {
            return Err("Server no longer exists; refresh the list".into());
        }
        let previous = old
            .get(name)
            .cloned()
            .and_then(|value| serde_json::from_value::<Server>(value).ok());
        for (key, value) in server.values() {
            if let ValueSource::Secret(reference) = value {
                if !secrets.contains_key(key)
                    && !previous
                        .as_ref()
                        .is_some_and(|old| old.values().values().any(|saved| saved == value))
                {
                    return Err(format!("Replace the secret for {key}"));
                }
                if reference.is_empty() && !secrets.contains_key(key) {
                    return Err("Secret is missing".into());
                }
            }
        }
        if secrets
            .keys()
            .any(|key| !matches!(server.values().get(key), Some(ValueSource::Secret(_))))
        {
            return Err(
                "A secret must refer to an environment variable or header marked Secret".into(),
            );
        }
        let mut staged = Vec::new();
        let mut removed = Vec::new();
        let result = (|| {
            for (key, value) in secrets {
                let reference = Uuid::new_v4().to_string();
                let account = credentials::account(&path, name, &reference);
                self.credentials.set(&account, &value)?;
                staged.push(account);
                server
                    .values_mut()
                    .insert(key, ValueSource::Secret(reference));
            }
            removed = self.remove_obsolete(&path, name, previous.as_ref(), Some(&server))?;
            self.write(
                target,
                name,
                Some(serde_json::to_value(&server).map_err(|_| "Invalid MCP server")?),
                create,
                old.get(name),
            )
        })();
        if result.is_err() {
            self.restore_credentials(&removed)?;
            for account in staged {
                let _ = self.credentials.delete(&account);
            }
            return result;
        }
        Ok(())
    }
    fn remove_obsolete(
        &self,
        path: &Path,
        name: &str,
        previous: Option<&Server>,
        next: Option<&Server>,
    ) -> Result<Vec<(String, String)>, String> {
        let mut obsolete = BTreeMap::new();
        if let Some(previous) = previous {
            for source in previous.values().values() {
                if let ValueSource::Secret(reference) = source {
                    if next.is_some_and(|next| next.values().values().any(|value| value == source))
                    {
                        continue;
                    }
                    let account = credentials::account(path, name, reference);
                    if let Some(value) = self.credentials.get(&account)? {
                        obsolete.insert(account, value);
                    }
                }
            }
        }
        let mut removed = Vec::new();
        for (account, value) in obsolete {
            if let Err(error) = self.credentials.delete(&account) {
                self.restore_credentials(&removed)?;
                return Err(error);
            }
            removed.push((account, value));
        }
        Ok(removed)
    }
    fn restore_credentials(&self, removed: &[(String, String)]) -> Result<(), String> {
        for (account, value) in removed {
            self.credentials.set(account, value).map_err(|_| "Credential rollback failed; unlock the OS credential store and replace the affected secrets")?;
        }
        Ok(())
    }
    pub fn remove(&self, target: &Target, name: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "MCP settings unavailable")?;
        let path = self.path(target)?;
        let old = self.read(target)?;
        let previous = old
            .get(name)
            .cloned()
            .and_then(|value| serde_json::from_value::<Server>(value).ok());
        // Delete credentials first so a locked store cannot silently orphan them.
        let removed = self.remove_obsolete(&path, name, previous.as_ref(), None)?;
        let result = self.write(target, name, None, false, old.get(name));
        if result.is_err() {
            self.restore_credentials(&removed)?;
        }
        result
    }

    pub fn toggle(&self, target: &Target, name: &str, enabled: bool) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "MCP settings unavailable")?;
        let old = self.read(target)?;
        let mut server = old
            .get(name)
            .cloned()
            .ok_or("Server no longer exists; refresh the list")?;
        let object = server.as_object_mut().ok_or("Invalid MCP server")?;
        object.insert("enabled".into(), json!(enabled));
        self.write(target, name, Some(server), false, old.get(name))
    }
    fn write(
        &self,
        target: &Target,
        name: &str,
        value: Option<Value>,
        create: bool,
        expected: Option<&Value>,
    ) -> Result<(), String> {
        if matches!(target, Target::Global) {
            return self
                .global
                .lock()
                .map_err(|_| "Settings unavailable")?
                .change_mcp(name, value, create, expected);
        }
        let path = self.path(target)?;
        let (before, mut document) = read_project(&path)?;
        if document.get("mcpServers").is_none() {
            document["mcpServers"] = json!({});
        }
        let servers = document["mcpServers"]
            .as_object_mut()
            .ok_or("mcpServers must be an object")?;
        if servers.get(name) != expected {
            return Err("MCP server changed while saving; refresh and retry".into());
        }
        if create && servers.contains_key(name) {
            return Err("Server already exists".into());
        }
        match value {
            Some(value) => {
                servers.insert(name.into(), value);
            }
            None => {
                servers.remove(name);
            }
        }
        let parent = path
            .parent()
            .ok_or("Project settings directory unavailable")?;
        std::fs::create_dir_all(parent).map_err(|_| "Cannot create project settings directory")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "Cannot save project MCP settings")?;
        serde_json::to_writer_pretty(temporary.as_file_mut(), &document)
            .map_err(|_| "Cannot save project MCP settings")?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| "Cannot save project MCP settings")?;
        if read_project(&path)?.0 != before {
            return Err("Settings changed while saving; retry".into());
        }
        temporary
            .persist(path)
            .map_err(|_| "Cannot save project MCP settings")?;
        Ok(())
    }
    fn combined(&self, folder: &Path) -> Result<BTreeMap<String, (PathBuf, Value)>, String> {
        let mut result = BTreeMap::new();
        for target in [
            Target::Global,
            Target::Project {
                folder: folder.into(),
            },
        ] {
            let path = self.path(&target)?;
            for (name, value) in self.read(&target)? {
                result.insert(name, (path.clone(), value));
            }
        }
        Ok(result)
    }
    pub fn revision(&self, folder: &Path) -> String {
        match self.combined(folder) {
            Ok(combined) => format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&combined).unwrap_or_default())
            ),
            Err(_) => "invalid".into(),
        }
    }
    pub fn resolve(
        &self,
        folder: &Path,
        working_folder: &Path,
        http: bool,
        environment: &BTreeMap<String, String>,
    ) -> Result<(Vec<McpServer>, SessionState), String> {
        let _guard = self.lock.lock().map_err(|_| "MCP settings unavailable")?;
        let combined = self
            .combined(folder)
            .map_err(|_| "Correct the global or project MCP settings file before reconnecting")?;
        let revision = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&combined).map_err(|_| "Invalid MCP settings")?)
        );
        let mut state = SessionState {
            revision,
            ..Default::default()
        };
        let mut servers = Vec::new();
        for (name, (path, value)) in combined {
            let result = (|| {
                let server: Server = serde_json::from_value(value)
                    .map_err(|_| "Unsupported or invalid server configuration".to_string())?;
                if !server.enabled {
                    return Ok(None);
                }
                server.validate()?;
                let values = || -> Result<Vec<(String, String)>, String> {
                    server
                        .values()
                        .iter()
                        .map(|(key, source)| {
                            let value = match source {
                                ValueSource::Literal(value) => value.clone(),
                                ValueSource::Environment(variable) => {
                                    environment.get(variable).cloned().ok_or_else(|| {
                                        format!("Environment variable for {key} is missing")
                                    })?
                                }
                                ValueSource::Secret(reference) => self
                                    .credentials
                                    .get(&credentials::account(&path, &name, reference))?
                                    .ok_or("Credential missing; replace the secret")?,
                            };
                            if value.contains('\0') {
                                return Err(format!("Invalid value for {key}"));
                            }
                            if value.is_empty() && !matches!(source, ValueSource::Literal(_)) {
                                return Err(format!(
                                    "Credential or environment value for {key} is empty"
                                ));
                            }
                            Ok((key.clone(), value))
                        })
                        .collect()
                };
                match &server.transport {
                    Transport::Stdio { command, args, .. } => {
                        let values = values()?;
                        let path = values
                            .iter()
                            .find(|(key, _)| key == "PATH")
                            .map(|(_, value)| std::ffi::OsString::from(value))
                            .or_else(|| environment.get("PATH").map(std::ffi::OsString::from));
                        let command = executable(command, working_folder, path.as_deref())
                            .ok_or("Executable not found or not executable")?;
                        Ok(Some(McpServer::Stdio(
                            McpServerStdio::new(&name, command).args(args.clone()).env(
                                values
                                    .into_iter()
                                    .map(|(key, value)| EnvVariable::new(key, value))
                                    .collect(),
                            ),
                        )))
                    }
                    Transport::Http { url, .. } => {
                        if !http {
                            return Err("Agent does not support HTTP MCP servers".into());
                        }
                        let headers = values()?
                            .into_iter()
                            .map(|(key, value)| {
                                reqwest::header::HeaderValue::from_str(&value)
                                    .map_err(|_| "Invalid HTTP header value")?;
                                Ok(HttpHeader::new(key, value))
                            })
                            .collect::<Result<Vec<_>, String>>()?;
                        Ok(Some(McpServer::Http(
                            McpServerHttp::new(&name, url).headers(headers),
                        )))
                    }
                }
            })();
            match result {
                Ok(Some(server)) => servers.push(server),
                Ok(None) => {}
                Err(reason) => state.issues.push(Issue { name, reason }),
            }
        }
        Ok((servers, state))
    }
}
fn read_project(path: &Path) -> Result<(Option<Vec<u8>>, Value), String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("Cannot read project MCP settings".into()),
    };
    let document = bytes
        .as_ref()
        .map(|bytes| serde_json::from_slice::<Value>(bytes))
        .transpose()
        .map_err(|_| "Invalid project MCP JSON")?
        .unwrap_or(json!({}));
    if !document.is_object()
        || document
            .get("mcpServers")
            .is_some_and(|value| !value.is_object())
    {
        return Err("Project MCP settings must contain a mcpServers object".into());
    }
    Ok((bytes, document))
}
fn executable(command: &str, folder: &Path, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let command = Path::new(command);
    let candidates: Vec<_> = if command.is_absolute() {
        vec![command.to_path_buf()]
    } else if command.components().count() > 1 {
        vec![folder.join(command)]
    } else {
        std::env::split_paths(path?)
            .map(|directory| {
                if directory.is_absolute() {
                    directory.join(command)
                } else {
                    folder.join(directory).join(command)
                }
            })
            .collect()
    };
    for candidate in candidates {
        #[cfg(windows)]
        let candidate = if candidate.extension().is_none() {
            candidate.with_extension("exe")
        } else {
            candidate
        };
        if !candidate.is_file() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if candidate.metadata().ok()?.permissions().mode() & 0o111 == 0 {
                continue;
            }
        }
        return candidate.canonicalize().ok();
    }
    None
}

#[tauri::command]
pub(crate) async fn subscribe_mcp(
    app: AppHandle,
    target: Target,
    channel: Channel<Snapshot>,
    window: tauri::Webview,
    subscriptions: State<'_, crate::Subscriptions>,
) -> Result<Uuid, String> {
    let service = app.state::<Arc<Mcp>>().inner().clone();
    service.path(&target)?;
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let token =
        crate::forward_subscription(receiver, channel, window, subscriptions.inner().clone())
            .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn(async move {
        let mut previous = None;
        loop {
            let service = service.clone();
            let target = target.clone();
            let Ok(snapshot) =
                tauri::async_runtime::spawn_blocking(move || service.snapshot(&target)).await
            else {
                break;
            };
            if previous.as_ref() != Some(&snapshot) {
                if sender.send(snapshot.clone()).is_err() {
                    break;
                }
                previous = Some(snapshot);
            }
            tokio::select! { _ = sender.closed() => break, _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {} }
        }
    });
    Ok(token)
}
#[tauri::command]
pub(crate) async fn save_mcp(
    app: AppHandle,
    target: Target,
    name: String,
    server: Server,
    secrets: BTreeMap<String, String>,
    create: bool,
) -> Result<(), String> {
    let service = app.state::<Arc<Mcp>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.save(&target, &name, server, secrets, create)
    })
    .await
    .map_err(|_| "MCP save failed")?
}
#[tauri::command]
pub(crate) async fn remove_mcp(app: AppHandle, target: Target, name: String) -> Result<(), String> {
    let service = app.state::<Arc<Mcp>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.remove(&target, &name))
        .await
        .map_err(|_| "MCP removal failed")?
}

#[tauri::command]
pub(crate) async fn toggle_mcp(
    app: AppHandle,
    target: Target,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let service = app.state::<Arc<Mcp>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.toggle(&target, &name, enabled))
        .await
        .map_err(|_| "MCP toggle failed")?
}

#[cfg(test)]
mod tests;
