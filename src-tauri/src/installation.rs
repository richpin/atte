//! Immutable installation directories and their path-independent manifests.

use crate::{
    agent::{AgentDefinition, LaunchKind},
    agent_management::{registry::Distribution, ManagementError},
    storage::Installation,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

pub(crate) const MANIFEST_NAME: &str = "installation.json";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    registry_version: String,
    installed_version: String,
    source_identity: Distribution,
    launch: StoredLaunch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Identity {
    pub(crate) registry_version: String,
    pub(crate) source_identity: Distribution,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct StoredLaunch {
    name: String,
    #[serde(default)]
    kind: LaunchKind,
    command: StoredPath,
    args: Vec<StoredArgument>,
    env: HashMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "base", content = "path", rename_all = "camelCase")]
enum StoredPath {
    Artifact(PathBuf),
    AppData(PathBuf),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
enum StoredArgument {
    Path { path: StoredPath },
    Literal(String),
}

pub(crate) fn staging_directory(
    agents_root: &Path,
    id: &str,
) -> Result<tempfile::TempDir, ManagementError> {
    let agent_root = agents_root.join(id);
    std::fs::create_dir_all(&agent_root).map_err(|_| ManagementError::Install)?;
    tempfile::Builder::new()
        .prefix(".staging-")
        .tempdir_in(agent_root)
        .map_err(|_| ManagementError::Install)
}

pub(crate) fn commit(
    app_data: &Path,
    registry_version: &str,
    source_identity: &Distribution,
    prepared: Installation,
) -> Result<Installation, ManagementError> {
    let id = &prepared.definition.id;
    let node_runtime = prepared.definition.node_runtime.clone();
    let app_data = app_data
        .canonicalize()
        .map_err(|_| ManagementError::Install)?;
    let agents_root = app_data.join("agents");
    let agent_root = agents_root.join(id);
    if prepared.artifact.parent() != Some(agent_root.as_path())
        || !prepared
            .artifact
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(".staging-"))
    {
        return Err(ManagementError::Install);
    }
    let launch =
        StoredLaunch::from_definition(&prepared.definition, &prepared.artifact, &app_data)?;
    let manifest = Manifest {
        registry_version: registry_version.into(),
        installed_version: prepared.version,
        source_identity: source_identity.source_identity(),
        launch,
    };
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|_| ManagementError::Install)?;
    std::fs::write(prepared.artifact.join(MANIFEST_NAME), bytes)
        .map_err(|_| ManagementError::Install)?;

    let destination = agent_root.join(uuid::Uuid::new_v4().to_string());
    std::fs::rename(&prepared.artifact, &destination).map_err(|_| ManagementError::Install)?;
    let mut installation = manifest.resolve(&app_data, destination, id)?;
    installation.definition.node_runtime = node_runtime;
    Ok(installation)
}

pub(crate) fn load(
    app_data: &Path,
    artifact: &Path,
    id: &str,
) -> Result<Installation, ManagementError> {
    let bytes =
        std::fs::read(artifact.join(MANIFEST_NAME)).map_err(|_| ManagementError::Install)?;
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| ManagementError::Install)?;
    manifest.resolve(app_data, artifact.to_owned(), id)
}

pub(crate) fn identity(artifact: &Path) -> Result<Identity, ManagementError> {
    let bytes =
        std::fs::read(artifact.join(MANIFEST_NAME)).map_err(|_| ManagementError::Install)?;
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| ManagementError::Install)?;
    Ok(Identity {
        registry_version: manifest.registry_version,
        source_identity: manifest.source_identity,
    })
}

pub(crate) fn recover(
    app_data: &Path,
    store: &crate::storage::Store,
) -> Result<(), ManagementError> {
    for agent in store.agents()? {
        match (agent.pending, agent.pending_artifact) {
            (Some(pending), _) if has_launch_files(&pending) => {
                store.promote_pending(&agent.id)?;
            }
            (Some(_), _) | (None, Some(_)) => store.clear_pending(&agent.id)?,
            (None, None) => {}
        }
    }
    cleanup_orphans(app_data, store)
}

fn cleanup_orphans(app_data: &Path, store: &crate::storage::Store) -> Result<(), ManagementError> {
    let agents_root = app_data.join("agents");
    let referenced: std::collections::HashSet<_> = store
        .agents()?
        .into_iter()
        .flat_map(|agent| [agent.installation, agent.pending])
        .flatten()
        .map(|installation| {
            installation
                .artifact
                .canonicalize()
                .unwrap_or(installation.artifact)
        })
        .collect();
    let Ok(agents) = std::fs::read_dir(&agents_root) else {
        return Ok(());
    };
    for agent in agents.flatten() {
        let path = agent.path();
        if path.file_name().is_some_and(|name| name == "runtime") || referenced.contains(&path) {
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        let Ok(installations) = std::fs::read_dir(&path) else {
            continue;
        };
        for installation in installations.flatten() {
            let artifact = installation.path();
            if !referenced.contains(&artifact) {
                let _ = if artifact.is_dir() {
                    std::fs::remove_dir_all(&artifact)
                } else {
                    std::fs::remove_file(&artifact)
                };
            }
        }
        if std::fs::read_dir(&path).is_ok_and(|mut entries| entries.next().is_none()) {
            let _ = std::fs::remove_dir(&path);
        }
    }
    Ok(())
}

pub(crate) fn has_launch_files(installation: &Installation) -> bool {
    installation.artifact.is_dir()
        && installation.definition.command.is_file()
        && installation
            .definition
            .args
            .first()
            .filter(|arg| Path::new(arg).is_absolute())
            .is_none_or(|arg| Path::new(arg).is_file())
}

impl StoredLaunch {
    fn from_definition(
        definition: &AgentDefinition,
        artifact: &Path,
        app_data: &Path,
    ) -> Result<Self, ManagementError> {
        let command = StoredPath::from_absolute(&definition.command, artifact, app_data)?;
        let args = definition
            .args
            .iter()
            .map(|argument| {
                let path = Path::new(argument);
                if path.is_absolute() {
                    StoredPath::from_absolute(path, artifact, app_data)
                        .map(|path| StoredArgument::Path { path })
                } else {
                    Ok(StoredArgument::Literal(argument.clone()))
                }
            })
            .collect::<Result<_, _>>()?;
        let mut env = definition.env.clone();
        if matches!(command, StoredPath::AppData(_)) {
            env.remove("PATH");
        }
        Ok(Self {
            name: definition.name.clone(),
            kind: definition.launch_kind,
            command,
            args,
            env,
        })
    }
}

impl StoredPath {
    fn from_absolute(
        path: &Path,
        artifact: &Path,
        app_data: &Path,
    ) -> Result<Self, ManagementError> {
        if let Ok(relative) = path.strip_prefix(artifact) {
            return Ok(Self::Artifact(relative.to_owned()));
        }
        if let Ok(relative) = path.strip_prefix(app_data) {
            return Ok(Self::AppData(relative.to_owned()));
        }
        Err(ManagementError::Install)
    }

    fn resolve(&self, app_data: &Path, artifact: &Path) -> Result<PathBuf, ManagementError> {
        let (base, path) = match self {
            Self::Artifact(path) => (artifact, path),
            Self::AppData(path) => (app_data, path),
        };
        if path.as_os_str().is_empty()
            || path
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err(ManagementError::Install);
        }
        Ok(base.join(path))
    }
}

impl Manifest {
    fn resolve(
        self,
        app_data: &Path,
        artifact: PathBuf,
        id: &str,
    ) -> Result<Installation, ManagementError> {
        let command = self.launch.command.resolve(app_data, &artifact)?;
        let args = self
            .launch
            .args
            .into_iter()
            .map(|argument| match argument {
                StoredArgument::Path { path } => path
                    .resolve(app_data, &artifact)
                    .map(|path| path.to_string_lossy().into_owned()),
                StoredArgument::Literal(value) => Ok(value),
            })
            .collect::<Result<Vec<_>, ManagementError>>()?;
        let mut env = self.launch.env;
        if command.starts_with(app_data.join("agents/runtime")) {
            env.insert(
                "PATH".into(),
                format!(
                    "{}:{}",
                    command.parent().unwrap_or(Path::new("/usr/bin")).display(),
                    std::env::var("PATH")
                        .unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into())
                ),
            );
        }
        Ok(Installation {
            definition: AgentDefinition {
                id: id.into(),
                name: self.launch.name,
                launch_kind: self.launch.kind,
                command,
                args,
                env,
                node_runtime: None,
            },
            version: self.installed_version,
            artifact,
        })
    }
}
