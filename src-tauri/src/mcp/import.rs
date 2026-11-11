//! Read-only external configuration and opaque, short-lived import review.
use super::*;
use std::time::{Duration, Instant};
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: usize = 1024 * 1024;
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Json,
    Jsonc,
    Codex,
    Zed,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    id: Option<Uuid>,
    name: String,
    transport: Option<&'static str>,
    reason: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    tool: String,
    path: String,
    status: &'static str,
    candidates: Vec<Candidate>,
    error: Option<String>,
}
struct Pending {
    expires: Instant,
    source: Option<PathBuf>,
    server: Server,
    secrets: BTreeMap<String, String>,
}
#[derive(Default)]
pub(super) struct Imports(Mutex<BTreeMap<Uuid, Pending>>);
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    id: Uuid,
    name: String,
    overwrite: bool,
}
#[derive(Serialize)]
pub struct ImportResult {
    id: Uuid,
    name: String,
    error: Option<String>,
}

impl Mcp {
    pub fn preview_import(&self, text: &str, format: Format, tool: &str, path: &str) -> Source {
        let mut source = Source {
            tool: tool.into(),
            path: path.into(),
            status: "ready",
            candidates: vec![],
            error: None,
        };
        let parsed = parse(text, format);
        match parsed {
            Err(reason) => {
                source.status = "error";
                source.error = Some(reason.into());
            }
            Ok(entries) => {
                let Ok(mut pending) = self.imports.0.lock() else {
                    source.status = "error";
                    source.error = Some("Import review unavailable".into());
                    return source;
                };
                pending.retain(|_, entry| entry.expires > Instant::now());
                for (name, value) in entries {
                    let mut candidate = Candidate {
                        id: None,
                        name,
                        transport: None,
                        reason: None,
                    };
                    match convert(value, format) {
                        Ok((server, secrets)) if pending.len() < 256 => {
                            let id = Uuid::new_v4();
                            candidate.id = Some(id);
                            candidate.transport = Some(match server.transport {
                                Transport::Stdio { .. } => "stdio",
                                Transport::Http { .. } => "http",
                            });
                            pending.insert(
                                id,
                                Pending {
                                    expires: Instant::now() + Duration::from_secs(900),
                                    source: Path::new(path)
                                        .is_absolute()
                                        .then(|| PathBuf::from(path)),
                                    server,
                                    secrets,
                                },
                            );
                        }
                        Ok(_) => {
                            candidate.reason =
                                Some("Review limit reached; close import review and retry".into())
                        }
                        Err(reason) => candidate.reason = Some(reason),
                    }
                    source.candidates.push(candidate);
                }
            }
        }
        source
    }
    pub fn clear_imports(&self) {
        if let Ok(mut pending) = self.imports.0.lock() {
            pending.clear();
        }
    }
    pub fn import_selected(
        &self,
        target: &Target,
        selections: Vec<Selection>,
    ) -> Vec<ImportResult> {
        selections
            .into_iter()
            .map(|selection| {
                let result = (|| {
                    let mut pending = self
                        .imports
                        .0
                        .lock()
                        .map_err(|_| "Import review unavailable")?;
                    let entry = pending
                        .get(&selection.id)
                        .filter(|entry| entry.expires > Instant::now())
                        .ok_or("Review expired; discover or paste again")?;
                    if let Some(source) = &entry.source {
                        let destination = self.path(target)?;
                        if source == &destination
                            || source
                                .canonicalize()
                                .ok()
                                .zip(destination.canonicalize().ok())
                                .is_some_and(|(source, destination)| source == destination)
                        {
                            return Err(
                                "The destination is the source file; choose a different scope"
                                    .into(),
                            );
                        }
                    }
                    self.save(
                        target,
                        &selection.name,
                        entry.server.clone(),
                        entry.secrets.clone(),
                        !selection.overwrite,
                    )?;
                    pending.remove(&selection.id);
                    Ok::<_, String>(())
                })();
                ImportResult {
                    id: selection.id,
                    name: selection.name,
                    error: result.err(),
                }
            })
            .collect()
    }
    pub(super) fn discover_at(&self, sources: Vec<(&str, PathBuf, Format)>) -> Vec<Source> {
        sources
            .into_iter()
            .map(|(tool, path, format)| {
                let display = path.to_string_lossy();
                match read_source(&path) {
                    Ok(text) => self.preview_import(&text, format, tool, &display),
                    Err(error) => Source {
                        tool: tool.into(),
                        path: display.into(),
                        status: if error == "File not found" {
                            "missing"
                        } else {
                            "error"
                        },
                        candidates: vec![],
                        error: Some(error.into()),
                    },
                }
            })
            .collect()
    }
}
fn read_source(path: &Path) -> Result<String, &'static str> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "File not found"
        } else {
            "Cannot read configuration file"
        }
    })?;
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read configuration file")?;
    if bytes.len() > MAX_BYTES {
        return Err("Configuration exceeds 1 MiB");
    }
    String::from_utf8(bytes).map_err(|_| "Configuration must be UTF-8")
}
fn parse(text: &str, format: Format) -> Result<Map<String, Value>, &'static str> {
    if text.len() > MAX_BYTES {
        return Err("Configuration exceeds 1 MiB");
    }
    let document: Value = match format {
        Format::Json => {
            serde_json::from_str(text).map_err(|_| "Invalid JSON; correct the source and retry")?
        }
        Format::Jsonc | Format::Zed => jsonc_parser::parse_to_serde_value(
            text,
            &jsonc_parser::ParseOptions {
                allow_comments: true,
                allow_trailing_commas: true,
                allow_loose_object_property_names: false,
                allow_missing_commas: false,
                allow_single_quoted_strings: false,
                allow_hexadecimal_numbers: false,
                allow_unary_plus_numbers: false,
                allow_bare_decimal_point_numbers: false,
                allow_non_finite_numbers: false,
                allow_extended_string_escapes: false,
            },
        )
        .map_err(|_| "Invalid JSONC; correct the source and retry")?,
        Format::Codex => {
            let value: toml::Value =
                toml::from_str(text).map_err(|_| "Invalid TOML; correct the source and retry")?;
            serde_json::to_value(value).map_err(|_| "Invalid TOML configuration")?
        }
    };
    let key = match format {
        Format::Codex => "mcp_servers",
        Format::Zed => "context_servers",
        _ => "mcpServers",
    };
    if !document.is_object() {
        return Err("Configuration must be an object");
    }
    match document.get(key) {
        None => Ok(Map::new()),
        Some(Value::Object(entries)) => Ok(entries.clone()),
        _ => Err("MCP server list must be an object"),
    }
}
fn strings(value: Option<&Value>) -> Result<BTreeMap<String, String>, String> {
    value
        .map(|value| {
            serde_json::from_value(value.clone()).map_err(|_| "Expected string values".into())
        })
        .unwrap_or_else(|| Ok(BTreeMap::new()))
}
fn variable(value: &str) -> Option<&str> {
    let name = value.strip_prefix("${")?.strip_suffix('}')?;
    let name = name.strip_prefix("env:").unwrap_or(name);
    (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .then_some(name)
}
fn has_expansion(value: &str) -> bool {
    value.contains('$') || value.contains("${") || value.contains("~")
}
fn credential_argument(argument: &str) -> bool {
    let normalized = argument.to_ascii_lowercase().replace('_', "-");
    if matches!(normalized.as_str(), "-h" | "-p" | "-k" | "-u")
        || normalized.starts_with("--header")
    {
        return true;
    }
    if normalized.starts_with('-')
        && normalized
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|word| matches!(word, "key" | "pass" | "auth" | "user"))
    {
        return true;
    }
    if [
        "token",
        "api-key",
        "apikey",
        "password",
        "passwd",
        "secret",
        "credential",
        "authorization",
        "authentication",
        "--auth",
        "bearer ",
        "basic ",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        return true;
    }
    // Environment assignments and URL parameters can carry untyped credentials.
    if !argument.starts_with('-') && argument.contains('=') {
        return true;
    }
    reqwest::Url::parse(argument).is_ok_and(|url| {
        !url.username().is_empty() || url.password().is_some() || url.query().is_some()
    })
}
fn convert(value: Value, format: Format) -> Result<(Server, BTreeMap<String, String>), String> {
    let object = value.as_object().ok_or("Server must be an object")?;
    let http = object.contains_key("url");
    let codex = matches!(format, Format::Codex);
    let common = ["command", "args", "env", "url", "type", "enabled"];
    let extra: &[&str] = if codex {
        &["env_vars", "http_headers", "env_http_headers"]
    } else {
        &["headers"]
    };
    // Unknown policy, auth, cwd and helper fields cannot be silently discarded.
    if object
        .keys()
        .any(|key| !common.contains(&key.as_str()) && !extra.contains(&key.as_str()))
    {
        return Err("Unsupported tool-specific options (including OAuth, helpers, working directory or tool policies); edit the source or add this server manually".into());
    }
    if object
        .get("enabled")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("enabled must be a boolean".into());
    }
    if let Some(kind) = object.get("type") {
        if kind.as_str() != Some(if http { "http" } else { "stdio" }) {
            return Err(
                "Unsupported transport; only stdio and Streamable HTTP can be imported".into(),
            );
        }
    }
    if http
        && ["command", "args", "env", "env_vars"]
            .iter()
            .any(|key| object.contains_key(*key))
    {
        return Err("Mixed HTTP and stdio settings are unsupported".into());
    }
    if !http
        && ["headers", "http_headers", "env_http_headers"]
            .iter()
            .any(|key| object.contains_key(*key))
    {
        return Err("HTTP headers require an HTTP server".into());
    }
    let endpoint = object
        .get(if http { "url" } else { "command" })
        .and_then(Value::as_str)
        .ok_or("Missing command or URL")?;
    if has_expansion(endpoint) {
        return Err("Variables in command or URL are unsupported; add the server manually".into());
    }
    if http {
        let url = reqwest::Url::parse(endpoint).map_err(|_| "Invalid HTTP URL")?;
        if url.query().is_some() {
            return Err("URLs with query values require manual review; move credentials into secret headers".into());
        }
    }
    let args: Vec<String> = object
        .get("args")
        .map(|value| {
            serde_json::from_value(value.clone()).map_err(|_| "Arguments must be a string array")
        })
        .transpose()?
        .unwrap_or_default();
    if args.iter().any(|arg| has_expansion(arg)) {
        return Err("Variables in arguments are unsupported; add the server manually".into());
    }
    if args.iter().any(|arg| credential_argument(arg)) {
        return Err("Arguments may contain credentials or headers; configure this server manually using secret environment variables or HTTP headers".into());
    }
    let mut secrets = BTreeMap::new();
    let mut values = BTreeMap::new();
    for (key, value) in strings(object.get(if http {
        if codex {
            "http_headers"
        } else {
            "headers"
        }
    } else {
        "env"
    }))? {
        let source = if let Some(name) = variable(&value) {
            ValueSource::Environment(name.into())
        } else {
            if has_expansion(&value) {
                return Err("Unsupported variable expression; only a whole ${NAME} or ${env:NAME} value is supported".into());
            }
            secrets.insert(key.clone(), value);
            ValueSource::Secret(String::new())
        };
        values.insert(key, source);
    }
    for (key, name) in strings(object.get("env_http_headers"))? {
        if values.insert(key, ValueSource::Environment(name)).is_some() {
            return Err("Duplicate header source".into());
        }
    }
    if let Some(env) = object.get("env_vars") {
        let names: Vec<String> =
            serde_json::from_value(env.clone()).map_err(|_| "env_vars must be a string array")?;
        for name in names {
            if values
                .insert(name.clone(), ValueSource::Environment(name))
                .is_some()
            {
                return Err("Duplicate environment source".into());
            }
        }
    }
    let server = Server {
        enabled: false,
        transport: if http {
            Transport::Http {
                url: endpoint.into(),
                headers: values,
            }
        } else {
            Transport::Stdio {
                command: endpoint.into(),
                args,
                env: values,
            }
        },
    };
    server
        .validate()
        .map_err(|_| "Invalid server values; review the source configuration")?;
    Ok((server, secrets))
}

#[tauri::command]
pub(crate) async fn discover_mcps(app: AppHandle) -> Result<Vec<Source>, String> {
    let service = app.state::<Arc<Mcp>>().inner().clone();
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Home directory unavailable")?;
    let config = app
        .path()
        .config_dir()
        .map_err(|_| "Configuration directory unavailable")?;
    let codex = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let zed = if cfg!(target_os = "macos") {
        home.join(".config/zed")
    } else {
        config.join("zed")
    };
    let claude = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Claude")
    } else {
        config.join("Claude")
    };
    tauri::async_runtime::spawn_blocking(move || {
        service.discover_at(vec![
            ("Claude Code", home.join(".claude.json"), Format::Json),
            (
                "Claude Desktop",
                claude.join("claude_desktop_config.json"),
                Format::Json,
            ),
            ("Cursor", home.join(".cursor/mcp.json"), Format::Jsonc),
            ("Codex", codex.join("config.toml"), Format::Codex),
            ("Zed", zed.join("settings.json"), Format::Zed),
        ])
    })
    .await
    .map_err(|_| "Discovery failed".into())
}
#[tauri::command]
pub(crate) async fn preview_mcp_import(
    app: AppHandle,
    text: String,
    format: Format,
) -> Result<Source, String> {
    let service = app.state::<Arc<Mcp>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.preview_import(&text, format, "Pasted configuration", "Clipboard input")
    })
    .await
    .map_err(|_| "Import review failed".into())
}
#[tauri::command]
pub(crate) async fn select_mcp_import(
    app: AppHandle,
    format: Format,
) -> Result<Option<Source>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("MCP configuration", &["json", "jsonc", "toml"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|_| "Select a local configuration file")?;
        let text = read_source(&path)?;
        Ok(Some(app.state::<Arc<Mcp>>().preview_import(
            &text,
            format,
            "Selected file",
            &path.to_string_lossy(),
        )))
    })
    .await
    .map_err(|_| "File selection failed")?
}
#[tauri::command]
pub(crate) async fn import_mcps(
    app: AppHandle,
    target: Target,
    selections: Vec<Selection>,
) -> Result<Vec<ImportResult>, String> {
    let service = app.state::<Arc<Mcp>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.import_selected(&target, selections))
        .await
        .map_err(|_| "Import failed".into())
}
#[tauri::command]
pub(crate) async fn clear_mcp_imports(app: AppHandle) -> Result<(), String> {
    let service = app.state::<Arc<Mcp>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.clear_imports())
        .await
        .map_err(|_| "Import review cleanup failed".into())
}
