use super::ManagementError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

#[derive(Clone, Deserialize)]
pub struct Registry {
    pub version: String,
    pub agents: Vec<RegistryAgent>,
}

#[derive(Clone, Deserialize)]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub distribution: Distributions,
}

#[derive(Clone, Default, Deserialize)]
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
    pub env: HashMap<String, String>,
    pub sha256: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Npm {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Distribution {
    Binary(Binary),
    Npm(Npm),
}

pub const TARGETS: [(&str, &str, &str); 3] = [
    ("claude", "claude-acp", "Claude"),
    ("codex", "codex-acp", "Codex"),
    ("antigravity", "antigravity-acp", "Antigravity"),
];

impl Registry {
    pub fn parse(json: &str) -> Result<Self, ManagementError> {
        let registry: Self = serde_json::from_str(json).map_err(|_| ManagementError::Registry)?;
        if registry.version != "1.0.0" {
            return Err(ManagementError::Registry);
        }
        Ok(registry)
    }

    pub fn target(&self, id: &str) -> Option<&RegistryAgent> {
        let (_, registry_id, _) = TARGETS.iter().find(|(target, _, _)| *target == id)?;
        self.agents.iter().find(|agent| agent.id == *registry_id)
    }
}

impl RegistryAgent {
    pub fn distribution(&self, platform: &str) -> Option<Distribution> {
        self.distribution
            .binary
            .get(platform)
            .cloned()
            .map(Distribution::Binary)
            .or_else(|| self.distribution.npx.clone().map(Distribution::Npm))
    }
}

pub fn platform() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    };
    format!("{os}-{}", std::env::consts::ARCH)
}
