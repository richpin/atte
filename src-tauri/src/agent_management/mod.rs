//! Agent setup application boundary, independent of Tauri and conversation lifetimes.
pub mod authentication;
pub mod installer;
pub mod registry;

use crate::{
    conversation::{AuthenticationStatus, Conversations},
    storage::{Installation, Store},
};
use authentication::Authentication;
use installer::Installer;
use registry::{Distribution, Registry, TARGETS};
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
    #[error("Node.js와 npm이 필요합니다. Node.js LTS를 설치한 뒤 다시 시도해주세요.")]
    NodeMissing,
    #[error("설치하지 못했습니다. 네트워크, 저장 공간과 폴더 권한을 확인한 뒤 다시 시도해주세요.")]
    Install,
    #[error("다운로드 검증에 실패했습니다. 다시 설치해주세요.")]
    Integrity,
    #[error("ACP 연결에 실패했습니다. 설치 상태를 확인하고 다시 시도해주세요.")]
    Connection,
    #[error("인증하지 못했습니다. 브라우저 또는 터미널에서 로그인을 완료한 뒤 다시 시도해주세요.")]
    Authentication,
    #[error("{0}")]
    AuthenticationPrerequisite(String),
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
    registry: Mutex<Option<Registry>>,
    authentication: Mutex<HashMap<String, Authentication>>,
    busy: Mutex<HashSet<String>>,
}

impl AgentManagement {
    pub fn open(root: &Path) -> Result<Self, ManagementError> {
        std::fs::create_dir_all(root).map_err(|_| ManagementError::Install)?;
        Ok(Self {
            root: root.into(),
            store: Store::open(&root.join("atte.sqlite"))?,
            registry: Mutex::new(None),
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
        *self
            .registry
            .lock()
            .map_err(|_| ManagementError::Registry)? = Some(registry);
        Ok(())
    }

    pub async fn refresh(&self) -> Result<(), ManagementError> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|_| ManagementError::Network)?;
        let json = client
            .get(registry::REGISTRY_URL)
            .send()
            .await
            .map_err(|_| ManagementError::Network)?
            .error_for_status()
            .map_err(|_| ManagementError::Network)?
            .text()
            .await
            .map_err(|_| ManagementError::Network)?;
        self.set_registry(Registry::parse(&json)?)
    }

    pub fn catalog(
        &self,
        conversations: &Conversations,
    ) -> Result<Vec<ManagedAgent>, ManagementError> {
        let installed = self.store.installations()?;
        let registry = self
            .registry
            .lock()
            .map_err(|_| ManagementError::Registry)?;
        let authentication = self
            .authentication
            .lock()
            .map_err(|_| ManagementError::Connection)?;
        Ok(TARGETS
            .iter()
            .map(|(id, _, name)| {
                let entry = registry.as_ref().and_then(|registry| registry.target(id));
                let installation = installed
                    .iter()
                    .find(|installation| installation.definition.id == *id);
                ManagedAgent {
                    id: (*id).into(),
                    name: (*name).into(),
                    available_version: entry.map(|entry| entry.version.clone()),
                    distribution: entry.and_then(|entry| entry.distribution(&registry::platform())),
                    installed_version: installation
                        .map(|installation| installation.version.clone()),
                    artifact: installation.map(|installation| installation.artifact.clone()),
                    installed: installation.is_some_and(usable),
                    authentication: {
                        let mut state = authentication.get(*id).cloned().unwrap_or_default();
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
        let entry = self
            .registry
            .lock()
            .map_err(|_| ManagementError::Registry)?
            .as_ref()
            .and_then(|registry| registry.target(id))
            .cloned()
            .ok_or(ManagementError::Registry)?;
        let distribution = entry
            .distribution(&registry::platform())
            .ok_or(ManagementError::Unsupported)?;
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
        self.store.save_installation(&installation)?;
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
        if !TARGETS.iter().any(|(target, _, _)| *target == id) {
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
