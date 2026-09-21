mod archive;
pub mod download;
pub mod node_runtime;
// Agent setup application boundary, independent of Tauri and thread lifetimes.
pub mod authentication;
pub mod installer;
pub mod registry;
mod removal;

use crate::{
    storage::Store,
    thread::{AuthenticationStatus, Threads},
};
use authentication::Authentication;
use futures_util::{stream, StreamExt};
use installer::{Installer, SystemInstaller};
use node_runtime::NodeRuntime;
use registry::{Distribution, Registry};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Serialize, thiserror::Error)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum ManagementError {
    #[error("Registry를 불러올 수 없습니다. 네트워크를 확인하고 다시 시도해주세요.")]
    Network,
    #[error("지원하는 Registry 배포 정보를 찾을 수 없습니다. 잠시 후 다시 시도해주세요.")]
    Registry,
    #[error("이 플랫폼에 맞는 배포가 없습니다.")]
    Unsupported,
    #[error("Node.js 런타임을 준비하지 못했습니다. 네트워크를 확인하고 다시 시도해주세요.")]
    NodeMissing,
    #[error("설치하지 못했습니다. 네트워크, 저장 공간과 폴더 권한을 확인한 뒤 다시 시도해주세요.")]
    Install,
    #[error("설치 파일을 삭제하지 못했습니다. 위치와 폴더 권한을 확인하고 다시 시도해주세요.")]
    Removal,
    #[error("다운로드 검증에 실패했습니다. 다시 설치해주세요.")]
    Integrity,
    #[error("ACP 연결에 실패했습니다. 설치 상태를 확인하고 다시 시도해주세요.")]
    Connection,
    #[error("인증하지 못했습니다. 브라우저 또는 터미널에서 로그인을 완료한 뒤 다시 시도해주세요.")]
    Authentication,
    #[error("로그인이 취소되었습니다.")]
    AuthenticationCancelled,
    #[error("에이전트가 제공한 이 인증 방식은 아직 지원하지 않습니다.")]
    UnsupportedAuthentication,
    #[error("이 에이전트는 로그아웃을 지원하지 않습니다.")]
    UnsupportedLogout,
    #[error("로그아웃하지 못했습니다. 다시 시도해주세요.")]
    Logout,
    #[error("진행 중인 작업이 있습니다. 완료 후 다시 시도해주세요.")]
    Busy,
    #[error("{0}")]
    Storage(String),
}

impl From<crate::storage::StorageError> for ManagementError {
    fn from(error: crate::storage::StorageError) -> Self {
        Self::Storage(error.to_string())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgent {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub description: String,
    pub unavailable_reason: Option<String>,
    pub available_version: Option<String>,
    pub distribution: Option<Distribution>,
    pub installed_version: Option<String>,
    pub artifact: Option<PathBuf>,
    pub installed: bool,
    pub authentication: Authentication,
}

pub struct AgentManagement {
    root: PathBuf,
    store: Arc<Store>,
    runtime: NodeRuntime,
    refresh_lock: tokio::sync::Mutex<()>,
    preparation_slots: tokio::sync::Semaphore,
    last_attempt: Mutex<i64>,
    authentication: Mutex<HashMap<String, Authentication>>,
    authentication_operations: Mutex<HashMap<String, AuthenticationOperation>>,
    authentication_generation: AtomicU64,
    node_runtimes: Mutex<HashMap<String, node_runtime::NodeRuntime>>,
    busy: Mutex<HashSet<String>>,
    update_cancellations: Mutex<HashMap<String, CancellationToken>>,
    operation_finished: tokio::sync::Notify,
}

impl AgentManagement {
    pub fn open(root: &Path) -> Result<Self, ManagementError> {
        Self::open_with_runtime(root, NodeRuntime::default())
    }

    /// Opens agent management with an injected app-scoped runtime resolver.
    /// Controlled integration tests use this to make runtime discovery deterministic.
    pub fn open_with_runtime(root: &Path, runtime: NodeRuntime) -> Result<Self, ManagementError> {
        std::fs::create_dir_all(root).map_err(|_| ManagementError::Install)?;
        let root = root.canonicalize().map_err(|_| ManagementError::Install)?;
        runtime.set_managed_root(root.join("agents/runtime"))?;
        let store = Store::open(&root.join("atte.sqlite"))?;
        crate::installation::recover(&root, &store)?;
        let fetched_at = store.registry_fetched_at()?;
        Ok(Self {
            root,
            store: Arc::new(store),
            runtime,
            refresh_lock: tokio::sync::Mutex::new(()),
            preparation_slots: tokio::sync::Semaphore::new(3),
            last_attempt: Mutex::new(fetched_at),
            authentication: Mutex::new(HashMap::new()),
            authentication_operations: Mutex::new(HashMap::new()),
            authentication_generation: AtomicU64::new(0),
            node_runtimes: Mutex::new(HashMap::new()),
            busy: Mutex::new(HashSet::new()),
            update_cancellations: Mutex::new(HashMap::new()),
            operation_finished: tokio::sync::Notify::new(),
        })
    }

    pub fn restore(&self, threads: &Threads) -> Result<(), ManagementError> {
        for mut installation in self.store.installations()? {
            if crate::installation::has_launch_files(&installation) {
                if installation.definition.launch_kind == crate::agent::LaunchKind::Node {
                    installation.definition.node_runtime = Some(self.runtime.clone());
                }
                threads
                    .register_agent(installation.definition)
                    .map_err(|_| ManagementError::Install)?;
            }
        }
        Ok(())
    }

    /// Restores the local list before resolving any agent execution definitions.
    pub fn restore_threads(&self) -> Result<Threads, ManagementError> {
        let threads = Threads::with_store(Vec::new(), self.store.clone())?;
        self.restore(&threads)?;
        Ok(threads)
    }

    pub(crate) fn installer(&self) -> SystemInstaller {
        SystemInstaller::new(download::HttpDownloader, self.runtime.clone())
    }

    pub fn set_registry(&self, registry: Registry) -> Result<(), ManagementError> {
        let json = serde_json::to_string(&registry).map_err(|_| ManagementError::Registry)?;
        Registry::parse(&json)?;
        self.store.save_registry(&registry, now())?;
        *self
            .last_attempt
            .lock()
            .map_err(|_| ManagementError::Registry)? = now();
        Ok(())
    }

    pub async fn refresh_if_stale(&self) -> Result<(), ManagementError> {
        self.refresh_from(registry::REGISTRY_URL, false).await
    }

    /// Registry transport boundary; desktop callers always use the official URL.
    pub async fn refresh_from(&self, url: &str, force: bool) -> Result<(), ManagementError> {
        let _refresh = self.refresh_lock.lock().await;
        {
            let mut last = self
                .last_attempt
                .lock()
                .map_err(|_| ManagementError::Registry)?;
            if !force && now().saturating_sub(*last) < 3600 {
                return Ok(());
            }
            *last = now();
        }
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|_| ManagementError::Network)?;
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|_| ManagementError::Network)?
            .error_for_status()
            .map_err(|_| ManagementError::Network)?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ManagementError::Network)?
        {
            if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
                return Err(ManagementError::Registry);
            }
            bytes.extend_from_slice(&chunk);
        }
        self.set_registry(Registry::parse(
            std::str::from_utf8(&bytes).map_err(|_| ManagementError::Registry)?,
        )?)
    }

    pub fn catalog(&self, threads: &Threads) -> Result<Vec<ManagedAgent>, ManagementError> {
        let agents = self.store.agents()?;
        let authentication = self
            .authentication
            .lock()
            .map_err(|_| ManagementError::Connection)?;
        Ok(agents
            .iter()
            .filter(|agent| {
                agent.installation.is_some()
                    || agent
                        .registry
                        .as_ref()
                        .is_some_and(|entry| entry.distribution(&registry::platform()).is_some())
            })
            .map(|agent| {
                let id = &agent.id;
                let entry = agent.registry.as_ref();
                let installation = agent.installation.as_ref();
                ManagedAgent {
                    id: id.clone(),
                    icon: entry.and_then(|entry| entry.icon.clone()),
                    name: entry
                        .map(|entry| entry.name.clone())
                        .or_else(|| installation.map(|item| item.definition.name.clone()))
                        .unwrap_or_else(|| id.clone()),
                    description: entry
                        .map(|entry| entry.description.clone())
                        .unwrap_or_default(),
                    unavailable_reason: entry.map_or_else(
                        || Some("Registry에서 제공하지 않는 기존 설치입니다.".into()),
                        |entry| entry.unsupported_reason(&registry::platform()),
                    ),
                    available_version: entry.map(|entry| entry.version.clone()),
                    distribution: entry.and_then(|entry| entry.distribution(&registry::platform())),
                    installed_version: installation
                        .map(|installation| installation.version.clone()),
                    artifact: installation.map(|installation| installation.artifact.clone()),
                    installed: installation.is_some_and(crate::installation::has_launch_files),
                    authentication: {
                        let mut state = authentication.get(id).cloned().unwrap_or_default();
                        if let Some(evidence) = threads.authentication_status(id) {
                            if evidence != AuthenticationStatus::Unknown {
                                state.connected = true;
                            }
                            state.authenticated = evidence == AuthenticationStatus::Authenticated;
                            state.required = evidence == AuthenticationStatus::Required;
                            if evidence == AuthenticationStatus::Authenticated {
                                if let Some(observation) = threads.authentication_observation(id) {
                                    state.logout_supported = observation.logout_supported;
                                    if observation.status_reported {
                                        state.email = observation.email;
                                        state.plan = observation.plan;
                                    }
                                }
                            }
                        }
                        state
                    },
                }
            })
            .collect())
    }

    pub async fn install(
        &self,
        id: &str,
        threads: &Threads,
        installer: &impl Installer,
        progress: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<(), ManagementError> {
        let _operation = self.begin(id)?;
        let stored = self
            .store
            .agents()?
            .into_iter()
            .find(|agent| agent.id == id)
            .ok_or(ManagementError::Registry)?;
        if let Some(existing) = stored
            .installation
            .as_ref()
            .filter(|item| crate::installation::has_launch_files(item))
        {
            threads
                .register_agent(existing.definition.clone())
                .map_err(|_| ManagementError::Install)?;
            progress("기존 설치 사용");
            return Ok(());
        }
        let entry = stored.registry.ok_or(ManagementError::Registry)?;
        let distribution = entry
            .distribution(&registry::platform())
            .ok_or(ManagementError::Unsupported)?;
        let previous_artifact = stored.installation.map(|existing| existing.artifact);
        let installation = installer
            .install(
                id,
                &entry,
                &distribution,
                &self.root.join("agents"),
                progress,
            )
            .await?;
        let installation =
            crate::installation::commit(&self.root, &entry.version, &distribution, installation)?;
        if installation.definition.id != id || !crate::installation::has_launch_files(&installation)
        {
            return Err(ManagementError::Install);
        }
        if let Some(runtime) = installation.definition.node_runtime.clone() {
            self.node_runtimes
                .lock()
                .map_err(|_| ManagementError::Install)?
                .insert(id.into(), runtime);
        }
        if let Err(error) = self.store.save_pending(&installation) {
            let _ = crate::installation_files::remove(&self.root, &installation.artifact);
            return Err(error.into());
        }
        self.store.promote_pending(id)?;
        threads
            .register_agent(installation.definition)
            .map_err(|_| ManagementError::Install)?;
        if let Some(previous) = previous_artifact {
            let _ = crate::installation_files::remove(&self.root, &previous);
        }
        self.authentication
            .lock()
            .map_err(|_| ManagementError::Connection)?
            .remove(id);
        progress("설치 완료");
        Ok(())
    }

    /// Prepares changed installations without delaying catalog or thread restoration.
    pub async fn prepare_updates(
        &self,
        threads: &Threads,
        installer: &impl Installer,
    ) -> Result<(), ManagementError> {
        let targets: Vec<_> = self
            .store
            .agents()?
            .into_iter()
            .filter_map(|agent| {
                let entry = agent.registry.as_ref()?;
                let distribution = entry.distribution(&registry::platform())?;
                let installed = agent.installation.as_ref()?;
                let active_is_current = matches_identity(
                    agent.installation_identity.as_ref(),
                    &entry.version,
                    &distribution,
                );
                ((!active_is_current || agent.pending.is_some())
                    && crate::installation::has_launch_files(installed))
                .then_some(agent.id)
            })
            .collect();
        stream::iter(targets)
            .for_each_concurrent(3, |id| async move {
                if let Err(error) = self.prepare_update(&id, threads, installer).await {
                    eprintln!("automatic agent update failed for {id}: {error}");
                }
            })
            .await;
        Ok(())
    }

    async fn prepare_update(
        &self,
        id: &str,
        threads: &Threads,
        installer: &impl Installer,
    ) -> Result<(), ManagementError> {
        let _slot = self
            .preparation_slots
            .acquire()
            .await
            .map_err(|_| ManagementError::Busy)?;
        let (_operation, cancellation) = self.begin_update(id)?;
        loop {
            let stored = self
                .store
                .agents()?
                .into_iter()
                .find(|agent| agent.id == id)
                .ok_or(ManagementError::Registry)?;
            let entry = stored.registry.as_ref().ok_or(ManagementError::Registry)?;
            let distribution = entry
                .distribution(&registry::platform())
                .ok_or(ManagementError::Unsupported)?;
            let active_is_current = matches_identity(
                stored.installation_identity.as_ref(),
                &entry.version,
                &distribution,
            );
            if active_is_current && stored.pending.is_none() {
                return Ok(());
            }
            let pending_is_current = matches_identity(
                stored.pending_identity.as_ref(),
                &entry.version,
                &distribution,
            );
            if !pending_is_current {
                let agents_root = self.root.join("agents");
                let prepared = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(ManagementError::Busy),
                    result = installer.install(id, entry, &distribution, &agents_root, &ignore_progress) => result?,
                };
                let installation = crate::installation::commit(
                    &self.root,
                    &entry.version,
                    &distribution,
                    prepared,
                )?;
                let latest = self
                    .store
                    .agents()?
                    .into_iter()
                    .find(|agent| agent.id == id)
                    .and_then(|agent| agent.registry)
                    .and_then(|entry| {
                        let distribution = entry.distribution(&registry::platform())?;
                        Some((entry.version, distribution))
                    });
                if latest.as_ref().is_none_or(|(version, source)| {
                    version != &entry.version || source != &distribution
                }) {
                    let _ = crate::installation_files::remove(&self.root, &installation.artifact);
                    continue;
                }
                let previous_pending = self.store.save_pending(&installation)?;
                if let Some(previous) =
                    previous_pending.filter(|path| path != &installation.artifact)
                {
                    let _ = crate::installation_files::remove(&self.root, &previous);
                }
            }
            let mut previous_active = None;
            threads
                .drain_and_replace_agent_until(id, &cancellation, || {
                    let (previous, pending) = self
                        .store
                        .promote_pending(id)
                        .map_err(|error| {
                            crate::thread::ThreadError::Unavailable(error.to_string())
                        })?
                        .ok_or_else(|| {
                            crate::thread::ThreadError::Unavailable(
                                "준비된 설치본을 찾을 수 없습니다.".into(),
                            )
                        })?;
                    previous_active = previous.map(|item| item.artifact);
                    let mut definition = pending.definition;
                    if definition.launch_kind == crate::agent::LaunchKind::Node {
                        definition.node_runtime = Some(self.runtime.clone());
                    }
                    Ok(definition)
                })
                .await
                .map_err(|_| ManagementError::Connection)?;
            if let Some(previous) = previous_active {
                let _ = crate::installation_files::remove(&self.root, &previous);
            }
            self.authentication
                .lock()
                .map_err(|_| ManagementError::Connection)?
                .remove(id);
            return Ok(());
        }
    }

    pub async fn authenticate(
        &self,
        id: &str,
        method: Option<&str>,
        threads: &Threads,
    ) -> Result<Authentication, ManagementError> {
        let operation = self.begin(id)?;
        let mut installation = self
            .store
            .installations()?
            .into_iter()
            .find(|installation| {
                installation.definition.id == id
                    && crate::installation::has_launch_files(installation)
            })
            .ok_or(ManagementError::Install)?;
        installation.definition.node_runtime = self
            .node_runtimes
            .lock()
            .map_err(|_| ManagementError::Connection)?
            .get(id)
            .cloned()
            .or_else(|| Some(self.runtime.clone()));
        self.authentication
            .lock()
            .map_err(|_| ManagementError::Connection)?
            .remove(id);
        if method.is_some() {
            threads.record_authentication(id, AuthenticationStatus::Unknown);
        }
        let generation = self
            .authentication_generation
            .fetch_add(1, Ordering::Relaxed);
        let cancellation = CancellationToken::new();
        self.authentication_operations
            .lock()
            .map_err(|_| ManagementError::Connection)?
            .insert(
                id.into(),
                AuthenticationOperation {
                    generation,
                    cancellation: cancellation.clone(),
                },
            );
        let result = authentication::inspect_cancellable(
            &installation.definition,
            &self.root,
            method,
            cancellation.clone(),
        )
        .await;
        let mut operations = self
            .authentication_operations
            .lock()
            .map_err(|_| ManagementError::Connection)?;
        let current = operations
            .get(id)
            .is_some_and(|operation| operation.generation == generation);
        if !current || cancellation.is_cancelled() {
            drop(operation);
            if current {
                operations.remove(id);
            }
            return Err(ManagementError::AuthenticationCancelled);
        }
        let state = match result {
            Ok(state) => state,
            Err(error) => {
                drop(operation);
                operations.remove(id);
                return Err(error);
            }
        };
        if state.authenticated {
            threads.record_authentication(id, AuthenticationStatus::Authenticated);
        }
        self.authentication
            .lock()
            .map_err(|_| ManagementError::Connection)?
            .insert(id.into(), state.clone());
        drop(operation);
        operations.remove(id);
        Ok(state)
    }

    pub async fn cancel_authentication(&self, id: &str) -> Result<(), ManagementError> {
        if !registry::valid_id(id) {
            return Err(ManagementError::Registry);
        }
        loop {
            let finished = self.operation_finished.notified();
            tokio::pin!(finished);
            finished.as_mut().enable();
            let cancellation = self
                .authentication_operations
                .lock()
                .map_err(|_| ManagementError::Connection)?
                .get(id)
                .map(|operation| operation.cancellation.clone());
            let Some(cancellation) = cancellation else {
                return Ok(());
            };
            cancellation.cancel();
            finished.await;
        }
    }

    pub async fn logout(&self, id: &str, threads: &Threads) -> Result<(), ManagementError> {
        let _operation = self.begin(id)?;
        let mut installation = self
            .store
            .installations()?
            .into_iter()
            .find(|installation| {
                installation.definition.id == id
                    && crate::installation::has_launch_files(installation)
            })
            .ok_or(ManagementError::Install)?;
        installation.definition.node_runtime = self
            .node_runtimes
            .lock()
            .map_err(|_| ManagementError::Connection)?
            .get(id)
            .cloned()
            .or_else(|| Some(self.runtime.clone()));
        authentication::logout(&installation.definition, &self.root).await?;
        self.authentication
            .lock()
            .map_err(|_| ManagementError::Connection)?
            .remove(id);
        threads.clear_authentication_evidence(id);
        Ok(())
    }

    fn begin(&self, id: &str) -> Result<Operation<'_>, ManagementError> {
        if !registry::valid_id(id) {
            return Err(ManagementError::Registry);
        }
        if !self
            .busy
            .lock()
            .map_err(|_| ManagementError::Busy)?
            .insert(id.into())
        {
            return Err(ManagementError::Busy);
        }
        Ok(Operation {
            manager: self,
            id: id.into(),
        })
    }

    fn begin_update(
        &self,
        id: &str,
    ) -> Result<(Operation<'_>, CancellationToken), ManagementError> {
        let operation = self.begin(id)?;
        let cancellation = CancellationToken::new();
        self.update_cancellations
            .lock()
            .map_err(|_| ManagementError::Busy)?
            .insert(id.into(), cancellation.clone());
        Ok((operation, cancellation))
    }

    async fn begin_removal(&self, id: &str) -> Result<Operation<'_>, ManagementError> {
        loop {
            let notified = self.operation_finished.notified();
            if let Some(cancellation) = self
                .update_cancellations
                .lock()
                .map_err(|_| ManagementError::Busy)?
                .get(id)
                .cloned()
            {
                cancellation.cancel();
            }
            match self.begin(id) {
                Ok(operation) => return Ok(operation),
                Err(ManagementError::Busy) => notified.await,
                Err(error) => return Err(error),
            }
        }
    }
}

fn matches_identity(
    identity: Option<&crate::installation::Identity>,
    registry_version: &str,
    source: &Distribution,
) -> bool {
    identity.is_some_and(|identity| {
        identity.registry_version == registry_version
            && identity.source_identity.has_same_source_identity(source)
    })
}

struct Operation<'a> {
    manager: &'a AgentManagement,
    id: String,
}

struct AuthenticationOperation {
    generation: u64,
    cancellation: CancellationToken,
}
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        if let Ok(mut busy) = self.manager.busy.lock() {
            busy.remove(&self.id);
        }
        if let Ok(mut cancellations) = self.manager.update_cancellations.lock() {
            cancellations.remove(&self.id);
        }
        self.manager.operation_finished.notify_waiters();
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn ignore_progress(_: &str) {}
