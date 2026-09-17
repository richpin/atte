mod archive;
pub mod download;
pub mod node_runtime;
// Agent setup application boundary, independent of Tauri and conversation lifetimes.
pub mod authentication;
pub mod installer;
pub mod registry;
mod removal;

use crate::{
    conversation::{AuthenticationStatus, Conversations},
    storage::{Installation, Store},
};
use authentication::Authentication;
use installer::Installer;
use registry::{Distribution, Registry};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, Serialize, thiserror::Error)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum ManagementError {
    #[error("Registry를 불러올 수 없습니다. 네트워크를 확인하고 다시 시도해주세요.")]
    Network,
    #[error("지원하는 Registry 배포 정보를 찾을 수 없습니다. 목록을 새로고침해주세요.")]
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
    #[error("에이전트가 제공한 이 인증 방식은 아직 지원하지 않습니다.")]
    UnsupportedAuthentication,
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
    store: Store,
    refresh_lock: tokio::sync::Mutex<()>,
    last_attempt: Mutex<i64>,
    authentication: Mutex<HashMap<String, Authentication>>,
    busy: Mutex<HashSet<String>>,
}

impl AgentManagement {
    pub fn open(root: &Path) -> Result<Self, ManagementError> {
        std::fs::create_dir_all(root).map_err(|_| ManagementError::Install)?;
        let store = Store::open(&root.join("atte.sqlite"))?;
        let fetched_at = store.registry_fetched_at()?;
        Ok(Self {
            root: root.into(),
            store,
            refresh_lock: tokio::sync::Mutex::new(()),
            last_attempt: Mutex::new(fetched_at),
            authentication: Mutex::new(HashMap::new()),
            busy: Mutex::new(HashSet::new()),
        })
    }

    pub fn restore(&self, conversations: &Conversations) -> Result<(), ManagementError> {
        for installation in self.store.installations()? {
            if usable(&installation) {
                conversations
                    .register_agent(installation.definition)
                    .map_err(|_| ManagementError::Install)?;
            }
        }
        Ok(())
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

    pub async fn refresh(&self) -> Result<(), ManagementError> {
        self.refresh_from(registry::REGISTRY_URL, true).await
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

    pub fn catalog(
        &self,
        conversations: &Conversations,
    ) -> Result<Vec<ManagedAgent>, ManagementError> {
        let agents = self.store.agents()?;
        let authentication = self
            .authentication
            .lock()
            .map_err(|_| ManagementError::Connection)?;
        Ok(agents
            .iter()
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
                    installed: installation.is_some_and(usable),
                    authentication: {
                        let mut state = authentication.get(id).cloned().unwrap_or_default();
                        if let Some(evidence) = conversations.authentication_status(id) {
                            if evidence != AuthenticationStatus::Unknown {
                                state.connected = true;
                            }
                            state.authenticated = evidence == AuthenticationStatus::Authenticated;
                            state.required = evidence == AuthenticationStatus::Required;
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
        conversations: &Conversations,
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
        if let Some(existing) = stored.installation.as_ref().filter(|item| usable(item)) {
            conversations
                .register_agent(existing.definition.clone())
                .map_err(|_| ManagementError::Install)?;
            progress("기존 설치 사용");
            return Ok(());
        }
        let entry = stored.registry.ok_or(ManagementError::Registry)?;
        let distribution = entry
            .distribution(&registry::platform())
            .ok_or(ManagementError::Unsupported)?;
        // A broken installation is retired before replacing its files or definition.
        if let Some(existing) = stored.installation {
            conversations
                .unregister_agent(id)
                .await
                .map_err(|_| ManagementError::Connection)?;
            let root = self.root.clone();
            tokio::task::spawn_blocking(move || {
                crate::installation_files::remove(&root, &existing.artifact)
            })
            .await
            .map_err(|_| ManagementError::Removal)?
            .map_err(|_| ManagementError::Removal)?;
            self.store.remove_installation(id)?;
        }
        let installation = installer
            .install(
                id,
                &entry,
                &distribution,
                &self.root.join("agents"),
                progress,
            )
            .await?;
        if installation.definition.id != id || !usable(&installation) {
            return Err(ManagementError::Install);
        }
        if let Err(error) = self.store.save_installation(&installation) {
            let _ = crate::installation_files::remove(&self.root, &installation.artifact);
            return Err(error.into());
        }
        conversations
            .register_agent(installation.definition)
            .map_err(|_| ManagementError::Install)?;
        self.authentication
            .lock()
            .map_err(|_| ManagementError::Connection)?
            .remove(id);
        progress("설치 완료");
        Ok(())
    }

    pub async fn authenticate(
        &self,
        id: &str,
        method: Option<&str>,
        conversations: &Conversations,
    ) -> Result<Authentication, ManagementError> {
        let _operation = self.begin(id)?;
        let installation = self
            .store
            .installations()?
            .into_iter()
            .find(|installation| installation.definition.id == id && usable(installation))
            .ok_or(ManagementError::Install)?;
        self.authentication
            .lock()
            .map_err(|_| ManagementError::Connection)?
            .remove(id);
        if method.is_some() {
            conversations.record_authentication(id, AuthenticationStatus::Unknown);
        }
        let state = authentication::inspect(&installation.definition, &self.root, method).await?;
        if state.authenticated {
            conversations.record_authentication(id, AuthenticationStatus::Authenticated);
        }
        self.authentication
            .lock()
            .map_err(|_| ManagementError::Connection)?
            .insert(id.into(), state.clone());
        Ok(state)
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
}

fn usable(installation: &Installation) -> bool {
    installation.artifact.is_dir()
        && installation.definition.command.is_file()
        && installation
            .definition
            .args
            .first()
            .filter(|arg| Path::new(arg).is_absolute())
            .is_none_or(|arg| Path::new(arg).is_file())
}

struct Operation<'a> {
    manager: &'a AgentManagement,
    id: String,
}
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        if let Ok(mut busy) = self.manager.busy.lock() {
            busy.remove(&self.id);
        }
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
