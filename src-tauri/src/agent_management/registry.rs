use super::ManagementError;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

#[derive(Clone, Deserialize, Serialize)]
pub struct Registry {
    pub version: String,
    pub agents: Vec<RegistryAgent>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    #[serde(default)]
    pub description: String,
    pub version: String,
    pub distribution: Distributions,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Distributions {
    #[serde(default)]
    pub binary: HashMap<String, Binary>,
    pub npx: Option<Npm>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Binary {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub sha256: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Npm {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Distribution {
    Binary(Binary),
    Npm(Npm),
}

impl Registry {
    pub fn parse(json: &str) -> Result<Self, ManagementError> {
        let registry: Self = serde_json::from_str(json).map_err(|_| ManagementError::Registry)?;
        let mut ids = std::collections::HashSet::new();
        if registry.version != "1.0.0"
            || registry
                .agents
                .iter()
                .any(|entry| !valid_id(&entry.id) || !ids.insert(&entry.id))
        {
            return Err(ManagementError::Registry);
        }
        Ok(registry)
    }

    pub fn target(&self, id: &str) -> Option<&RegistryAgent> {
        self.agents.iter().find(|agent| agent.id == id)
    }
}

impl RegistryAgent {
    pub fn unsupported_reason(&self, platform: &str) -> Option<String> {
        if self.distribution(platform).is_some() {
            None
        } else if self.distribution.binary.contains_key(platform) {
            Some("지원하지 않는 바이너리 압축·설치 형식입니다.".into())
        } else if self.distribution.binary.is_empty() {
            Some("지원하지 않는 배포 형식입니다. binary 또는 npx 배포가 필요합니다.".into())
        } else {
            Some(format!("{platform} 플랫폼 배포가 없습니다."))
        }
    }
    pub fn distribution(&self, platform: &str) -> Option<Distribution> {
        if let Some(binary) = self.distribution.binary.get(platform) {
            super::archive::supported_url(&binary.archive)
                .then(|| Distribution::Binary(binary.clone()))
        } else {
            self.distribution.npx.clone().map(Distribution::Npm)
        }
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub fn platform() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    };
    format!("{os}-{}", std::env::consts::ARCH)
}
