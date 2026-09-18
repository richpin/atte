use super::{
    archive::{self, enclosed},
    download::{self, Downloader, HttpDownloader},
    node_runtime::{node_path, NodeRuntime},
};
use super::{
    registry::{Distribution, RegistryAgent},
    ManagementError,
};
use crate::{agent::AgentDefinition, storage::Installation};
use std::{future::Future, path::Path, pin::Pin, process::Stdio, time::Duration};
use tokio::process::Command;

pub type InstallFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Installation, ManagementError>> + Send + 'a>>;

/// The external package installation boundary; tests supply controlled artifacts.
pub trait Installer: Send + Sync {
    fn install<'a>(
        &'a self,
        id: &'a str,
        entry: &'a RegistryAgent,
        distribution: &'a Distribution,
        root: &'a Path,
        progress: &'a (dyn Fn(&str) + Send + Sync),
    ) -> InstallFuture<'a>;
}

pub struct SystemInstaller<D = HttpDownloader> {
    downloads: D,
    runtime: NodeRuntime,
}

impl Default for SystemInstaller {
    fn default() -> Self {
        Self::new(HttpDownloader, NodeRuntime::default())
    }
}
impl<D: Downloader> SystemInstaller<D> {
    pub fn new(downloads: D, runtime: NodeRuntime) -> Self {
        Self { downloads, runtime }
    }
}

impl<D: Downloader> Installer for SystemInstaller<D> {
    fn install<'a>(
        &'a self,
        id: &'a str,
        entry: &'a RegistryAgent,
        distribution: &'a Distribution,
        root: &'a Path,
        progress: &'a (dyn Fn(&str) + Send + Sync),
    ) -> InstallFuture<'a> {
        Box::pin(async move {
            // Unique immutable directories keep old conversations on their original artifacts.
            if !super::registry::valid_id(id) {
                return Err(ManagementError::Registry);
            }
            std::fs::create_dir_all(root).map_err(|_| ManagementError::Install)?;
            let root = root.canonicalize().map_err(|_| ManagementError::Install)?;
            let staging = tempfile::Builder::new()
                .prefix(&format!("{id}-"))
                .tempdir_in(&root)
                .map_err(|_| ManagementError::Install)?;
            let result = self
                .install_distribution(id, entry, distribution, staging.path(), &root, progress)
                .await?;
            let _ = staging.keep();
            Ok(result)
        })
    }
}

impl<D: Downloader> SystemInstaller<D> {
    async fn install_distribution(
        &self,
        id: &str,
        entry: &RegistryAgent,
        distribution: &Distribution,
        artifact: &Path,
        root: &Path,
        progress: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<Installation, ManagementError> {
        let (command, args, env, version) = match distribution {
            Distribution::Npm(npm) => {
                progress("Node.js 확인 중");
                let runtime = self
                    .runtime
                    .prepare(&root.join("runtime"), &self.downloads, progress)
                    .await?;
                let node = runtime.node.clone();
                let (package, version) = npm
                    .package
                    .rsplit_once('@')
                    .ok_or(ManagementError::Registry)?;
                if package.is_empty()
                    || version.is_empty()
                    || package.starts_with('-')
                    || package.contains("..")
                    || package.contains(':')
                    || package.contains('\\')
                    || package.trim_start_matches('@').split('/').any(|part| {
                        part.is_empty()
                            || !part
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
                    })
                    || (package.contains('/')
                        && (!package.starts_with('@') || package.matches('/').count() != 1))
                {
                    return Err(ManagementError::Registry);
                }
                progress("npm 패키지 다운로드·설치 중");
                let mut install = runtime.npm_command();
                install
                    .args(["install", "--prefix"])
                    .arg(artifact)
                    .args([
                        "--save-exact",
                        "--no-audit",
                        "--no-fund",
                        "--ignore-scripts",
                        "--",
                        &npm.package,
                    ])
                    .env("PATH", node_path(&node))
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .kill_on_drop(true);
                run_command(install, Duration::from_secs(300)).await?;
                let package_root = artifact.join("node_modules").join(package);
                let metadata: serde_json::Value = serde_json::from_slice(
                    &std::fs::read(package_root.join("package.json"))
                        .map_err(|_| ManagementError::Install)?,
                )
                .map_err(|_| ManagementError::Install)?;
                let resolved = metadata["version"]
                    .as_str()
                    .ok_or(ManagementError::Install)?;
                if version
                    .bytes()
                    .next()
                    .is_some_and(|byte| byte.is_ascii_digit())
                    && resolved != version
                {
                    return Err(ManagementError::Install);
                }
                let bin = metadata["bin"]
                    .as_str()
                    .or_else(|| {
                        metadata["bin"]
                            .as_object()
                            .and_then(|bins| {
                                bins.get(package.rsplit('/').next().unwrap_or(package))
                                    .or_else(|| {
                                        if bins.len() == 1 {
                                            bins.values().next()
                                        } else {
                                            None
                                        }
                                    })
                            })
                            .and_then(|bin| bin.as_str())
                    })
                    .ok_or(ManagementError::Install)?;
                let executable = enclosed(&package_root, Path::new(bin))?;
                let executable = executable
                    .canonicalize()
                    .map_err(|_| ManagementError::Install)?;
                if !executable.starts_with(artifact) || !executable.is_file() {
                    return Err(ManagementError::Install);
                }
                let mut args = vec![executable.to_string_lossy().into_owned()];
                args.extend(npm.args.clone());
                let mut env: std::collections::HashMap<_, _> =
                    npm.env.clone().into_iter().collect();
                env.insert("PATH".into(), node_path(&node));
                (node, args, env, resolved.to_owned())
            }
            Distribution::Binary(binary) => {
                progress("바이너리 다운로드 중");
                let archive_file =
                    tempfile::NamedTempFile::new().map_err(|_| ManagementError::Install)?;
                self.downloads
                    .download(&binary.archive, archive_file.path(), progress)
                    .await?;
                download::verify(archive_file.path(), binary.sha256.as_deref())?;
                progress("압축 해제 중");
                let output = artifact.to_owned();
                let metadata = binary.clone();
                tokio::task::spawn_blocking(move || {
                    archive::extract(
                        archive_file.path(),
                        &metadata.archive,
                        &output,
                        &metadata.cmd,
                        false,
                    )
                })
                .await
                .map_err(|_| ManagementError::Install)??;
                let mut args = binary.args.clone();
                let mut env: std::collections::HashMap<_, _> =
                    binary.env.clone().into_iter().collect();
                let command = if binary.cmd == "node" {
                    let runtime = self
                        .runtime
                        .prepare(&root.join("runtime"), &self.downloads, progress)
                        .await?;
                    env.insert("PATH".into(), node_path(&runtime.node));
                    runtime.node
                } else {
                    let command = enclosed(artifact, Path::new(&binary.cmd))?;
                    archive::executable_mode(&command, 0o755)?;
                    command
                };
                for arg in &mut args {
                    if arg.starts_with("./")
                        || (!arg.starts_with('-') && artifact.join(&*arg).is_file())
                    {
                        *arg = enclosed(artifact, Path::new(arg))?
                            .to_string_lossy()
                            .into_owned();
                    }
                }
                if !command.is_file() {
                    return Err(ManagementError::Install);
                }
                (command, args, env, entry.version.clone())
            }
        };
        progress("설치 산출물 확인 중");
        Ok(Installation {
            definition: AgentDefinition {
                id: id.into(),
                name: entry.name.clone(),
                command,
                args,
                env,
            },
            version,
            artifact: artifact.into(),
        })
    }
}

pub(crate) async fn run_command(
    mut command: Command,
    timeout: Duration,
) -> Result<(), ManagementError> {
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| ManagementError::Install)?;
    let group = crate::agent_runtime::ProcessGroup(child.id());
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        _ => {
            drop(group);
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(ManagementError::Install)
        }
    }
}
