use super::{
    archive,
    download::{self, Downloader},
    installer::run_command,
    registry::Binary,
    ManagementError,
};
use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{process::Command, sync::Mutex};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const SHELL_TIMEOUT: Duration = Duration::from_secs(3);

static PREPARATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// App-scoped resolver for compatible system or managed Node.js/npm pairs.
#[derive(Clone, Debug)]
pub struct NodeRuntime {
    distribution: Arc<Binary>,
    directory: Arc<str>,
    candidates: CandidatePaths,
    cached: Arc<Mutex<Option<(PathBuf, PreparedNode)>>>,
    managed_root: Arc<std::sync::Mutex<Option<PathBuf>>>,
}

#[derive(Clone, Debug)]
enum CandidatePaths {
    Environment,
    Controlled {
        login_shell: Option<PathBuf>,
        process_path: Option<OsString>,
    },
}

impl Default for NodeRuntime {
    fn default() -> Self {
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let directory = format!("node-v24.21.0-darwin-{arch}");
        let checksum = if arch == "arm64" {
            "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"
        } else {
            "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097"
        };
        Self::new(
            Binary {
                archive: format!("https://nodejs.org/dist/v24.21.0/{directory}.tar.gz"),
                cmd: String::new(),
                args: vec![],
                env: Default::default(),
                sha256: Some(checksum.into()),
                unknown: Default::default(),
            },
            directory,
            CandidatePaths::Environment,
        )
    }
}

/// Origin of a resolved Node.js/npm pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeSource {
    /// A pair discovered from the user's login-shell or app-process `PATH`.
    System,
    /// The checksum-verified runtime maintained in Atte's app data.
    Managed,
}

/// A validated Node.js/npm pair and the `PATH` it must use.
#[derive(Clone, Debug)]
pub struct PreparedNode {
    /// Absolute Node.js executable path.
    pub node: PathBuf,
    /// Absolute npm executable or JavaScript entrypoint path.
    pub npm: PathBuf,
    /// Whether the pair belongs to the system or Atte.
    pub source: NodeSource,
    /// Environment path associated with this resolved pair.
    pub path: OsString,
    npm_home: Option<PathBuf>,
}

impl NodeRuntime {
    fn new(distribution: Binary, directory: String, candidates: CandidatePaths) -> Self {
        Self {
            distribution: Arc::new(distribution),
            directory: directory.into(),
            candidates,
            cached: Arc::new(Mutex::new(None)),
            managed_root: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// Controlled managed runtime for integration tests; never exposed over IPC.
    pub fn managed(distribution: Binary, directory: String) -> Self {
        Self::new(
            distribution,
            directory,
            CandidatePaths::Controlled {
                login_shell: None,
                process_path: None,
            },
        )
    }

    /// Controlled system candidates for integration tests; never exposed over IPC.
    pub fn controlled(
        distribution: Binary,
        directory: String,
        login_shell: Option<PathBuf>,
        process_path: Option<OsString>,
    ) -> Self {
        Self::new(
            distribution,
            directory,
            CandidatePaths::Controlled {
                login_shell,
                process_path,
            },
        )
    }

    /// Resolves and validates a Node.js/npm pair, preparing the managed fallback if needed.
    ///
    /// Returns a runtime preparation error only after all silent system candidates fail.
    pub async fn resolve(
        &self,
        root: &Path,
        downloads: &impl Downloader,
        progress: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<PreparedNode, ManagementError> {
        let root = root.canonicalize().unwrap_or_else(|_| root.to_owned());
        *self
            .managed_root
            .lock()
            .map_err(|_| ManagementError::NodeMissing)? = Some(root.clone());
        let mut cached = self.cached.lock().await;
        if let Some((_, prepared)) = cached
            .as_ref()
            .filter(|(cached_root, _)| cached_root == &root)
        {
            if compatible(prepared).await {
                return Ok(prepared.clone());
            }
        }

        for path in self.system_paths().await {
            if let Some(prepared) = system_runtime(&path).await {
                *cached = Some((root.clone(), prepared.clone()));
                return Ok(prepared);
            }
        }

        let prepared = self.prepare_managed(&root, downloads, progress).await?;
        *cached = Some((root, prepared.clone()));
        Ok(prepared)
    }

    pub(crate) fn set_managed_root(&self, root: PathBuf) -> Result<(), ManagementError> {
        *self
            .managed_root
            .lock()
            .map_err(|_| ManagementError::NodeMissing)? = Some(root);
        Ok(())
    }

    async fn resolve_for_launch(&self) -> Result<PreparedNode, ManagementError> {
        let root = self
            .managed_root
            .lock()
            .map_err(|_| ManagementError::NodeMissing)?
            .clone()
            .ok_or(ManagementError::NodeMissing)?;
        self.resolve(&root, &super::download::HttpDownloader, &|_| {})
            .await
    }

    async fn system_paths(&self) -> Vec<OsString> {
        match &self.candidates {
            CandidatePaths::Environment => {
                let mut paths = Vec::new();
                if let Some(path) = login_shell_path(None).await {
                    paths.push(path);
                }
                if let Some(path) = std::env::var_os("PATH") {
                    paths.push(path);
                }
                paths
            }
            CandidatePaths::Controlled {
                login_shell,
                process_path,
            } => {
                let mut paths = Vec::new();
                if let Some(shell) = login_shell {
                    if let Some(path) = login_shell_path(Some(shell)).await {
                        paths.push(path);
                    }
                }
                if let Some(path) = process_path {
                    paths.push(path.clone());
                }
                paths
            }
        }
    }

    async fn prepare_managed(
        &self,
        root: &Path,
        downloads: &impl Downloader,
        progress: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<PreparedNode, ManagementError> {
        let _preparation = PREPARATION.lock().await;
        if !cfg!(target_os = "macos") {
            return Err(ManagementError::Unsupported);
        }
        std::fs::create_dir_all(root).map_err(|_| ManagementError::NodeMissing)?;
        let destination = archive::enclosed(root, Path::new(self.directory.as_ref()))?;
        let prepared = managed_runtime(&destination, root)?;
        if compatible(&prepared).await {
            return Ok(prepared);
        }

        progress("관리형 Node.js 다운로드·준비 중");
        let staging = tempfile::tempdir_in(root).map_err(|_| ManagementError::NodeMissing)?;
        let archive_file = staging.path().join("download");
        downloads
            .download(&self.distribution.archive, &archive_file, progress)
            .await?;
        download::verify(&archive_file, self.distribution.sha256.as_deref())?;
        let extracted = staging.path().join("unpacked");
        let url = self.distribution.archive.clone();
        let output = extracted.clone();
        tokio::task::spawn_blocking(move || {
            archive::extract(&archive_file, &url, &output, "node", true)
        })
        .await
        .map_err(|_| ManagementError::NodeMissing)??;
        let staged = archive::enclosed(&extracted, Path::new(self.directory.as_ref()))?;
        let candidate = managed_runtime(&staged, root)?;
        if !compatible(&candidate).await {
            return Err(ManagementError::NodeMissing);
        }
        // A bad previous runtime is replaced only after the new one has passed both probes.
        if destination.exists() {
            std::fs::remove_dir_all(&destination).map_err(|_| ManagementError::NodeMissing)?;
        }
        std::fs::rename(staged, &destination).map_err(|_| ManagementError::NodeMissing)?;
        managed_runtime(&destination, root)
    }
}

async fn login_shell_path(shell: Option<&PathBuf>) -> Option<OsString> {
    let shell = shell
        .cloned()
        .or_else(|| std::env::var_os("SHELL").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
    let output = Command::new(shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let Ok(Ok(output)) = tokio::time::timeout(SHELL_TIMEOUT, output).await else {
        return None;
    };
    output
        .status
        .success()
        .then(|| OsString::from(String::from_utf8_lossy(&output.stdout).trim().to_owned()))
        .filter(|path| !path.is_empty())
}

async fn system_runtime(path: &OsStr) -> Option<PreparedNode> {
    let node = find_in_path(path, "node")?;
    let npm = find_in_path(path, "npm")?;
    let prepared = PreparedNode {
        node,
        npm,
        source: NodeSource::System,
        path: path.to_owned(),
        npm_home: None,
    };
    compatible(&prepared).await.then_some(prepared)
}

fn find_in_path(path: &OsStr, name: &str) -> Option<PathBuf> {
    std::env::split_paths(path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

fn managed_runtime(root: &Path, runtime_root: &Path) -> Result<PreparedNode, ManagementError> {
    let npm_home = runtime_root.join("npm");
    std::fs::create_dir_all(npm_home.join("cache")).map_err(|_| ManagementError::NodeMissing)?;
    for name in ["userconfig", "globalconfig"] {
        let path = npm_home.join(name);
        if !path.exists() {
            std::fs::write(path, []).map_err(|_| ManagementError::NodeMissing)?;
        }
    }
    let node = root.join("bin/node");
    Ok(PreparedNode {
        path: node_path(&node),
        node,
        npm: root.join("lib/node_modules/npm/bin/npm-cli.js"),
        source: NodeSource::Managed,
        npm_home: Some(npm_home),
    })
}

async fn compatible(runtime: &PreparedNode) -> bool {
    if !runtime.node.is_file() || !runtime.npm.is_file() {
        return false;
    }
    let version = Command::new(&runtime.node)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let Ok(Ok(output)) = tokio::time::timeout(PROBE_TIMEOUT, version).await else {
        return false;
    };
    let major = String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok());
    if !output.status.success() || major.is_none_or(|major| major < 22) {
        return false;
    }
    let mut command = runtime.npm_command();
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    run_command(command, PROBE_TIMEOUT).await.is_ok()
}

impl PreparedNode {
    /// Builds an npm command with user configuration for system npm and isolated
    /// configuration/cache paths for managed npm.
    pub fn npm_command(&self) -> Command {
        let mut command = if self.source == NodeSource::Managed {
            let mut command = Command::new(&self.node);
            command.arg(&self.npm);
            command
        } else {
            Command::new(&self.npm)
        };
        command.env("PATH", &self.path);
        if let Some(home) = &self.npm_home {
            for (key, _) in std::env::vars_os() {
                if is_isolated_npm_setting(&key) {
                    command.env_remove(key);
                }
            }
            for key in [
                "NPM_CONFIG_REGISTRY",
                "NPM_CONFIG__AUTH",
                "NPM_CONFIG__AUTH_TOKEN",
                "NPM_CONFIG_USERNAME",
                "NPM_CONFIG_PASSWORD",
                "NPM_CONFIG_ALWAYS_AUTH",
                "NPM_CONFIG_MINIMUM_RELEASE_AGE",
                "NPM_CONFIG_MIN_RELEASE_AGE",
                "NPM_TOKEN",
                "NODE_AUTH_TOKEN",
            ] {
                command.env_remove(key);
            }
            command
                .env("NPM_CONFIG_USERCONFIG", home.join("userconfig"))
                .env("NPM_CONFIG_GLOBALCONFIG", home.join("globalconfig"))
                .env("NPM_CONFIG_CACHE", home.join("cache"));
        }
        command
    }
}

fn is_isolated_npm_setting(key: &OsStr) -> bool {
    let key = key.to_string_lossy().to_ascii_uppercase();
    let Some(setting) = key.strip_prefix("NPM_CONFIG_") else {
        return matches!(key.as_str(), "NPM_TOKEN" | "NODE_AUTH_TOKEN");
    };
    !matches!(
        setting,
        "PROXY"
            | "HTTPS_PROXY"
            | "NOPROXY"
            | "NO_PROXY"
            | "CA"
            | "CAFILE"
            | "CERT"
            | "KEY"
            | "STRICT_SSL"
    )
}

pub(crate) struct ResolvedLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub path: Option<OsString>,
}

pub(crate) async fn resolve_launch(
    agent: &crate::agent::AgentDefinition,
) -> Result<ResolvedLaunch, ManagementError> {
    if agent.launch_kind == crate::agent::LaunchKind::Direct {
        return Ok(ResolvedLaunch {
            program: agent.command.clone(),
            args: agent.args.clone(),
            path: None,
        });
    }
    let runtime = agent
        .node_runtime
        .as_ref()
        .ok_or(ManagementError::NodeMissing)?;
    let prepared = runtime.resolve_for_launch().await?;
    let mut args = vec![agent.command.to_string_lossy().into_owned()];
    args.extend(agent.args.clone());
    Ok(ResolvedLaunch {
        program: prepared.node,
        args,
        path: Some(prepared.path),
    })
}

pub(crate) fn node_path(node: &Path) -> OsString {
    let inherited =
        std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    std::env::join_paths(
        std::iter::once(node.parent().unwrap_or(Path::new("/usr/bin")).to_path_buf())
            .chain(std::env::split_paths(&inherited)),
    )
    .unwrap_or(inherited)
}

#[cfg(test)]
mod tests {
    use super::is_isolated_npm_setting;
    use std::ffi::OsStr;

    #[test]
    fn managed_npm_isolates_policy_but_preserves_proxy_and_certificate_settings() {
        for key in [
            "NPM_CONFIG_REGISTRY",
            "npm_config_min_release_age",
            "NPM_CONFIG__AUTH_TOKEN",
            "NPM_TOKEN",
        ] {
            assert!(is_isolated_npm_setting(OsStr::new(key)), "{key}");
        }
        for key in [
            "NPM_CONFIG_PROXY",
            "npm_config_https_proxy",
            "NPM_CONFIG_CAFILE",
            "NODE_EXTRA_CA_CERTS",
        ] {
            assert!(!is_isolated_npm_setting(OsStr::new(key)), "{key}");
        }
    }
}
