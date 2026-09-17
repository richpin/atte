use super::{
    archive,
    download::{self, Downloader},
    installer::run_command,
    registry::Binary,
    ManagementError,
};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

static PREPARATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub struct NodeRuntime {
    distribution: Binary,
    directory: String,
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
        Self {
            distribution: Binary {
                archive: format!("https://nodejs.org/dist/v24.21.0/{directory}.tar.gz"),
                cmd: String::new(),
                args: vec![],
                env: Default::default(),
                sha256: Some(checksum.into()),
            },
            directory,
        }
    }
}

pub struct PreparedNode {
    pub node: PathBuf,
    pub npm: PathBuf,
}

impl NodeRuntime {
    /// Controlled runtime distribution for integration tests; never exposed over IPC.
    pub fn managed(distribution: Binary, directory: String) -> Self {
        Self {
            distribution,
            directory,
        }
    }

    pub async fn prepare(
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
        let destination = archive::enclosed(root, Path::new(&self.directory))?;
        let prepared = runtime_paths(&destination);
        if compatible(&prepared.node, &prepared.npm, true).await {
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
        let staged = archive::enclosed(&extracted, Path::new(&self.directory))?;
        let candidate = runtime_paths(&staged);
        if !compatible(&candidate.node, &candidate.npm, true).await {
            return Err(ManagementError::NodeMissing);
        }
        // A bad previous runtime is replaced only after the new one has passed both probes.
        if destination.exists() {
            std::fs::remove_dir_all(&destination).map_err(|_| ManagementError::NodeMissing)?;
        }
        std::fs::rename(staged, destination).map_err(|_| ManagementError::NodeMissing)?;
        Ok(prepared)
    }
}

fn runtime_paths(root: &Path) -> PreparedNode {
    PreparedNode {
        node: root.join("bin/node"),
        npm: root.join("lib/node_modules/npm/bin/npm-cli.js"),
    }
}

async fn compatible(node: &Path, npm: &Path, npm_script: bool) -> bool {
    if !node.is_file() || !npm.is_file() {
        return false;
    }
    let version = Command::new(node)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(10), version).await else {
        return false;
    };
    let major = String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok());
    if !output.status.success() || major.is_none_or(|major| major < 24) {
        return false;
    }
    let mut command = Command::new(if npm_script { node } else { npm });
    if npm_script {
        command.arg(npm);
    }
    command
        .arg("--version")
        .env("PATH", node_path(node))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    run_command(command, Duration::from_secs(10)).await.is_ok()
}

impl PreparedNode {
    pub fn npm_command(&self) -> Command {
        let mut command = if self
            .npm
            .extension()
            .is_some_and(|extension| extension == "js")
        {
            let mut command = Command::new(&self.node);
            command.arg(&self.npm);
            command
        } else {
            Command::new(&self.npm)
        };
        command.env("PATH", node_path(&self.node));
        command
    }
}

pub(crate) fn node_path(node: &Path) -> String {
    format!(
        "{}:{}",
        node.parent().unwrap_or(Path::new("/usr/bin")).display(),
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into())
    )
}
