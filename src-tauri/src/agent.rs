//! Prepared launch definitions. Registry installation can supply the same values.
use serde::Serialize;
use std::{collections::HashMap, path::PathBuf};

/// Trusted backend configuration, never accepted as a frontend command argument.
#[derive(Clone, Debug)]
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

/// The manually prepared target used until Registry installation is available.
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
