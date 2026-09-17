//! Trusted agent launch definitions shared by setup and the ACP runtime.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};

/// Trusted backend configuration, never accepted as a frontend command argument.
#[derive(Clone, Debug, Serialize, Deserialize)]
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

const CODEX_API_KEY_GUIDANCE: &str = "API Key 방식은 앱 실행 환경에 CODEX_API_KEY 또는 OPENAI_API_KEY가 필요합니다. 키를 설정한 터미널에서 Atte를 실행한 뒤 다시 시도하세요. 브라우저 로그인은 ChatGPT를 선택하세요.";

/// Compatibility guidance for the installed Codex adapter's environment-based key method.
pub(crate) fn authentication_guidance(
    agent: &AgentDefinition,
    method: &agent_client_protocol::schema::v1::AuthMethod,
) -> Option<String> {
    if agent.id == "codex" && method.id().to_string() == "api-key" {
        Some(CODEX_API_KEY_GUIDANCE.into())
    } else {
        method.description().map(str::to_owned)
    }
}

pub(crate) fn check_authentication_prerequisite(
    agent: &AgentDefinition,
    method: &agent_client_protocol::schema::v1::AuthMethod,
) -> Result<(), crate::agent_management::ManagementError> {
    if agent.id == "codex"
        && method.id().to_string() == "api-key"
        && !["CODEX_API_KEY", "OPENAI_API_KEY"].iter().any(|key| {
            agent
                .env
                .get(*key)
                .cloned()
                .or_else(|| std::env::var(key).ok())
                .is_some_and(|value| !value.trim().is_empty())
        })
    {
        return Err(
            crate::agent_management::ManagementError::AuthenticationPrerequisite(
                CODEX_API_KEY_GUIDANCE.into(),
            ),
        );
    }
    Ok(())
}
