//! Trusted agent launch definitions shared by setup and the ACP runtime.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};

/// How an installed agent entrypoint must be launched.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaunchKind {
    /// Execute the installed program directly.
    #[default]
    Direct,
    /// Resolve a compatible Node.js runtime and pass it the installed entrypoint.
    Node,
}

/// Trusted backend configuration, never accepted as a frontend command argument.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    /// Whether `command` is a direct executable or a Node.js entrypoint.
    #[serde(default)]
    pub launch_kind: LaunchKind,
    /// Installed executable or entrypoint path; never a resolved system Node path.
    pub command: PathBuf,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    /// App-scoped runtime policy attached when a Node definition is activated.
    #[serde(skip)]
    pub node_runtime: Option<crate::agent_management::node_runtime::NodeRuntime>,
}

/// Presentation metadata without executable paths or environment values.
#[derive(Clone, Serialize)]
pub struct PreparedAgent {
    pub id: String,
    pub name: String,
}

/// Prepared target for development probes. The desktop restores Registry installations.
pub fn prepared_codex() -> AgentDefinition {
    AgentDefinition {
        id: "codex".into(),
        name: "Codex".into(),
        launch_kind: LaunchKind::Direct,
        command: std::env::var_os("ATTE_CODEX_ACP")
            .map(PathBuf::from)
            .unwrap_or_else(|| "codex-acp".into()),
        args: vec![],
        env: HashMap::new(),
        node_runtime: None,
    }
}
