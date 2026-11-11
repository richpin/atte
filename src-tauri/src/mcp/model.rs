use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum ValueSource {
    Literal(String),
    Environment(String),
    Secret(String),
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(flatten)]
    pub transport: Transport,
}
fn enabled() -> bool {
    true
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Transport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, ValueSource>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, ValueSource>,
    },
}
impl Server {
    pub fn values(&self) -> &BTreeMap<String, ValueSource> {
        match &self.transport {
            Transport::Stdio { env, .. } => env,
            Transport::Http { headers, .. } => headers,
        }
    }
    pub fn values_mut(&mut self) -> &mut BTreeMap<String, ValueSource> {
        match &mut self.transport {
            Transport::Stdio { env, .. } => env,
            Transport::Http { headers, .. } => headers,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        match &self.transport {
            Transport::Stdio { command, args, env } => {
                if command.trim().is_empty()
                    || command.contains('\0')
                    || args.iter().any(|arg| arg.contains('\0'))
                {
                    return Err("Enter a command and valid arguments".into());
                }
                if env
                    .keys()
                    .any(|key| key.is_empty() || key.contains(['=', '\0']))
                {
                    return Err("Invalid environment variable name".into());
                }
            }
            Transport::Http { url, headers } => {
                let parsed = reqwest::Url::parse(url).map_err(|_| "Enter a valid HTTP URL")?;
                if !matches!(parsed.scheme(), "http" | "https")
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.fragment().is_some()
                {
                    return Err("Use an HTTP URL without embedded credentials or a fragment".into());
                }
                for key in headers.keys() {
                    reqwest::header::HeaderName::from_bytes(key.as_bytes())
                        .map_err(|_| "Invalid HTTP header name")?;
                }
            }
        }
        for source in self.values().values() {
            if let ValueSource::Environment(name) = source {
                if name.is_empty() || name.contains(['=', '\0']) {
                    return Err("Invalid environment reference".into());
                }
            }
        }
        Ok(())
    }
}
