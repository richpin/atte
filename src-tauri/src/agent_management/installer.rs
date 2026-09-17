use super::{
    registry::{Distribution, RegistryAgent},
    ManagementError,
};
use crate::{agent::AgentDefinition, storage::Installation};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    io::Write,
    path::{Component, Path, PathBuf},
    pin::Pin,
    process::Stdio,
    time::Duration,
};
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

pub struct SystemInstaller;

impl Installer for SystemInstaller {
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
            let artifact = root.join(format!("{id}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&artifact).map_err(|_| ManagementError::Install)?;
            let result = install_distribution(id, entry, distribution, &artifact, progress).await;
            if result.is_err() {
                let _ = std::fs::remove_dir_all(&artifact);
            }
            result
        })
    }
}

async fn install_distribution(
    id: &str,
    entry: &RegistryAgent,
    distribution: &Distribution,
    artifact: &Path,
    progress: &(dyn Fn(&str) + Send + Sync),
) -> Result<Installation, ManagementError> {
    let (command, args, env, version) = match distribution {
        Distribution::Npm(npm) => {
            progress("Node.js 확인 중");
            let node = find_program("node").ok_or(ManagementError::NodeMissing)?;
            let npm_command = node
                .parent()
                .ok_or(ManagementError::NodeMissing)?
                .join("npm");
            if !npm_command.is_file() {
                return Err(ManagementError::NodeMissing);
            }
            let (package, version) = npm
                .package
                .rsplit_once('@')
                .ok_or(ManagementError::Registry)?;
            if package.is_empty()
                || version != entry.version
                || package.starts_with('-')
                || package.contains("..")
                || package.contains(':')
            {
                return Err(ManagementError::Registry);
            }
            progress("npm 패키지 다운로드·설치 중");
            let mut install = Command::new(npm_command);
            install
                .args(["install", "--prefix"])
                .arg(artifact)
                .args([
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
            if resolved != entry.version {
                return Err(ManagementError::Install);
            }
            let bin = metadata["bin"]
                .as_str()
                .or_else(|| {
                    metadata["bin"]
                        .as_object()
                        .filter(|bins| bins.len() == 1)
                        .and_then(|bins| bins.values().next())
                        .and_then(|bin| bin.as_str())
                })
                .ok_or(ManagementError::Install)?;
            let executable = enclosed(&package_root, bin)?;
            if !executable.is_file() {
                return Err(ManagementError::Install);
            }
            let mut args = vec![executable.to_string_lossy().into_owned()];
            args.extend(npm.args.clone());
            let mut env = npm.env.clone();
            env.insert("PATH".into(), node_path(&node));
            (node, args, env, resolved.to_owned())
        }
        Distribution::Binary(binary) => {
            progress("바이너리 다운로드 중");
            let url =
                reqwest::Url::parse(&binary.archive).map_err(|_| ManagementError::Registry)?;
            if url.scheme() != "https" {
                return Err(ManagementError::Registry);
            }
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(300))
                .build()
                .map_err(|_| ManagementError::Network)?;
            let mut response = client
                .get(url)
                .send()
                .await
                .map_err(|_| ManagementError::Network)?
                .error_for_status()
                .map_err(|_| ManagementError::Network)?;
            let archive = artifact.join("download.zip");
            let mut file = std::fs::File::create(&archive).map_err(|_| ManagementError::Install)?;
            let mut hash = Sha256::new();
            let mut downloaded = 0u64;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| ManagementError::Network)?
            {
                downloaded += chunk.len() as u64;
                if downloaded > 1024 * 1024 * 1024 {
                    return Err(ManagementError::Install);
                }
                file.write_all(&chunk)
                    .map_err(|_| ManagementError::Install)?;
                hash.update(&chunk);
                progress(&format!("다운로드 {} MB", downloaded / (1024 * 1024)));
            }
            if binary.sha256.as_ref().is_some_and(|expected| {
                !expected.eq_ignore_ascii_case(&format!("{:x}", hash.finalize()))
            }) {
                return Err(ManagementError::Integrity);
            }
            drop(file);
            progress("압축 해제 중");
            let output = artifact.to_owned();
            tokio::task::spawn_blocking(move || extract_zip(&archive, &output))
                .await
                .map_err(|_| ManagementError::Install)??;
            let command = enclosed(artifact, &binary.cmd)?;
            if !command.is_file() {
                return Err(ManagementError::Install);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755))
                    .map_err(|_| ManagementError::Install)?;
            }
            (
                command,
                binary.args.clone(),
                binary.env.clone(),
                entry.version.clone(),
            )
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

fn extract_zip(archive: &Path, output: &Path) -> Result<(), ManagementError> {
    let file = std::fs::File::open(archive).map_err(|_| ManagementError::Install)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| ManagementError::Install)?;
    let mut expanded = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|_| ManagementError::Install)?;
        expanded = expanded.saturating_add(entry.size());
        if expanded > 2 * 1024 * 1024 * 1024 || entry.is_symlink() {
            return Err(ManagementError::Install);
        }
        let path = entry.enclosed_name().ok_or(ManagementError::Install)?;
        let destination = output.join(path);
        if entry.is_dir() {
            std::fs::create_dir_all(destination).map_err(|_| ManagementError::Install)?;
        } else {
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|_| ManagementError::Install)?;
            }
            let mut file =
                std::fs::File::create(&destination).map_err(|_| ManagementError::Install)?;
            std::io::copy(&mut entry, &mut file).map_err(|_| ManagementError::Install)?;
            #[cfg(unix)]
            if let Some(mode) = entry.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(
                    &destination,
                    std::fs::Permissions::from_mode(mode & 0o777),
                )
                .map_err(|_| ManagementError::Install)?;
            }
        }
    }
    std::fs::remove_file(archive).map_err(|_| ManagementError::Install)?;
    Ok(())
}

fn enclosed(root: &Path, relative: &str) -> Result<PathBuf, ManagementError> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(ManagementError::Registry);
    }
    Ok(root.join(path))
}

pub(crate) fn find_program(name: &str) -> Option<PathBuf> {
    let mut paths =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect::<Vec<_>>();
    // Finder-launched macOS apps have a minimal PATH. Standard installations need no manual path field.
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if let Some(home) = std::env::var_os("HOME") {
        if let Ok(versions) = std::fs::read_dir(PathBuf::from(home).join(".nvm/versions/node")) {
            let mut versions = versions
                .filter_map(Result::ok)
                .map(|item| item.path().join("bin"))
                .collect::<Vec<_>>();
            versions.sort();
            versions.reverse();
            paths.extend(versions);
        }
    }
    paths
        .into_iter()
        .map(|path| path.join(name))
        .find(|path| path.is_file())
}

fn node_path(node: &Path) -> String {
    format!(
        "{}:{}",
        node.parent().unwrap_or(Path::new("/usr/bin")).display(),
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into())
    )
}

pub(crate) async fn run_command(
    mut command: Command,
    timeout: Duration,
) -> Result<(), ManagementError> {
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| ManagementError::Install)?;
    let _group = crate::agent_runtime::ProcessGroup(child.id());
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        _ => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(ManagementError::Install)
        }
    }
}
