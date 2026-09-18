//! Trusted agent launch definitions shared by setup and the ACP runtime.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};

/// Trusted backend configuration, never accepted as a frontend command argument.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    pub command: PathBuf,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
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
        command: std::env::var_os("ATTE_CODEX_ACP")
            .map(PathBuf::from)
            .unwrap_or_else(|| "codex-acp".into()),
        args: vec![],
        env: HashMap::new(),
    }
}
