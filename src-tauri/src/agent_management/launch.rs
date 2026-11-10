//! Installed entrypoints and their OS/npm execution contracts.
use super::{archive::enclosed, ManagementError};
use crate::agent::{AgentDefinition, LaunchKind};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

/// Select npm's bin using the same single-target/alias/package-name rule as npm exec.
fn npm_bin<'a>(
    metadata: &'a serde_json::Value,
    package: &'a str,
) -> Result<(&'a str, &'a str), ManagementError> {
    let name = package
        .rsplit('/')
        .next()
        .ok_or(ManagementError::Registry)?;
    let bin = &metadata["bin"];
    if let Some(target) = bin.as_str() {
        return Ok((name, target));
    }
    let bins = bin
        .as_object()
        .filter(|bins| !bins.is_empty())
        .ok_or(ManagementError::Install)?;
    let first = bins.iter().next().ok_or(ManagementError::Install)?;
    let (command, target) = if bins.values().all(|target| target == first.1) {
        first
    } else {
        bins.get_key_value(name).ok_or(ManagementError::Install)?
    };
    Ok((command, target.as_str().ok_or(ManagementError::Install)?))
}

pub(crate) fn npm_command(artifact: &Path, package: &str) -> Result<PathBuf, ManagementError> {
    let package_root = enclosed(&artifact.join("node_modules"), Path::new(package))?;
    validate_file(artifact, &package_root.join("package.json"))?;
    let metadata: serde_json::Value = serde_json::from_slice(
        &std::fs::read(package_root.join("package.json")).map_err(|_| ManagementError::Install)?,
    )
    .map_err(|_| ManagementError::Install)?;
    let (name, target) = npm_bin(&metadata, package)?;
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(ManagementError::Integrity);
    }
    let bin_root = artifact.join("node_modules/.bin");
    let command = enclosed(
        &bin_root,
        Path::new(&format!(
            "{name}{}",
            if cfg!(windows) { ".cmd" } else { "" }
        )),
    )?;
    let target = enclosed(&package_root, Path::new(target))?;
    validate_file(artifact, &target)?;
    validate_file(artifact, &command)?;
    // npm can link an optional platform dependency's bin instead of the top-level
    // wrapper (for example Cline). Both must stay inside this installation.
    // Keep the launcher path: canonicalizing it would discard npm's execution contract.
    Ok(command)
}

pub(crate) fn validate_file(artifact: &Path, path: &Path) -> Result<(), ManagementError> {
    let root = artifact
        .canonicalize()
        .map_err(|_| ManagementError::Install)?;
    let resolved = path.canonicalize().map_err(|_| ManagementError::Install)?;
    if !resolved.starts_with(root) || !resolved.is_file() {
        return Err(ManagementError::Integrity);
    }
    Ok(())
}

pub(crate) struct ResolvedLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub path: Option<OsString>,
}

pub(crate) async fn resolve(agent: &AgentDefinition) -> Result<ResolvedLaunch, ManagementError> {
    if super::registry::exclusion_reason(&agent.id).is_some() {
        return Err(ManagementError::Unsupported);
    }
    if agent.launch_kind == LaunchKind::Direct {
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
    if agent.launch_kind == LaunchKind::Npm {
        let bin = agent.command.parent().ok_or(ManagementError::Install)?;
        let artifact = bin
            .parent()
            .and_then(Path::parent)
            .ok_or(ManagementError::Install)?;
        if bin.file_name() != Some(std::ffi::OsStr::new(".bin"))
            || bin.parent().and_then(Path::file_name) != Some(std::ffi::OsStr::new("node_modules"))
        {
            return Err(ManagementError::Integrity);
        }
        validate_file(artifact, &agent.command)?;
        let path = std::env::join_paths(
            std::iter::once(
                prepared
                    .node
                    .parent()
                    .ok_or(ManagementError::NodeMissing)?
                    .to_path_buf(),
            )
            .chain(std::iter::once(bin.to_path_buf()))
            .chain(std::env::split_paths(&prepared.path)),
        )
        .map_err(|_| ManagementError::NodeMissing)?;
        return Ok(ResolvedLaunch {
            program: agent.command.clone(),
            args: agent.args.clone(),
            path: Some(path),
        });
    }
    let mut args = vec![agent.command.to_string_lossy().into_owned()];
    args.extend(agent.args.clone());
    Ok(ResolvedLaunch {
        program: prepared.node,
        args,
        path: Some(prepared.path),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn npm_bin_matches_npm_alias_and_package_name_selection() {
        for (bin, package, expected) in [
            (json!("cli"), "@scope/agent", ("agent", "cli")),
            (json!({"other":"cli"}), "@scope/agent", ("other", "cli")),
            (
                json!({"alias":"cli", "second":"cli"}),
                "@scope/agent",
                ("alias", "cli"),
            ),
            (
                json!({"agent":"cli", "lowmem":"lowmem"}),
                "@scope/agent",
                ("agent", "cli"),
            ),
        ] {
            let metadata = json!({"bin": bin});
            assert_eq!(npm_bin(&metadata, package).unwrap(), expected);
        }
        for bin in [
            json!({}),
            json!({"first":"a", "second":"b"}),
            json!({"agent":7}),
            json!(null),
        ] {
            assert!(npm_bin(&json!({"bin":bin}), "@scope/agent").is_err());
        }
    }

    fn package(root: &Path, bin: serde_json::Value) -> PathBuf {
        let package = root.join("node_modules/@scope/agent");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(root.join("node_modules/.bin")).unwrap();
        std::fs::write(package.join("package.json"), json!({"bin":bin}).to_string()).unwrap();
        package
    }

    #[cfg(unix)]
    #[test]
    fn installed_bin_keeps_npm_link_and_accepts_postinstall_native_links() {
        use std::os::unix::fs::symlink;
        for hard_link in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let package = package(root.path(), json!({"agent":"cli"}));
            std::fs::copy(std::env::current_exe().unwrap(), package.join("native")).unwrap();
            if hard_link {
                std::fs::hard_link(package.join("native"), package.join("cli")).unwrap();
            } else {
                symlink("native", package.join("cli")).unwrap();
            }
            let launcher = root.path().join("node_modules/.bin/agent");
            symlink("../@scope/agent/cli", &launcher).unwrap();
            assert_eq!(npm_command(root.path(), "@scope/agent").unwrap(), launcher);
        }
    }

    #[test]
    fn rejects_missing_ambiguous_and_traversing_bins() {
        let root = tempfile::tempdir().unwrap();
        for bin in [
            json!({"agent":"missing"}),
            json!({"a":"a", "b":"b"}),
            json!({"../escape":"cli"}),
            json!({"agent":"../../outside"}),
        ] {
            package(root.path(), bin);
            assert!(npm_command(root.path(), "@scope/agent").is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn npm_optional_dependency_can_supply_the_installed_bin() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let package = package(root.path(), json!({"agent":"cli"}));
        std::fs::write(package.join("cli"), "#!/usr/bin/env node\n").unwrap();
        let native = root.path().join("node_modules/@scope/platform/bin/agent");
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::copy(std::env::current_exe().unwrap(), &native).unwrap();
        let launcher = root.path().join("node_modules/.bin/agent");
        symlink("../@scope/platform/bin/agent", &launcher).unwrap();
        assert_eq!(npm_command(root.path(), "@scope/agent").unwrap(), launcher);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_external_package_entrypoint_and_launcher() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let package = package(root.path(), json!({"agent":"cli"}));
        let launcher = root.path().join("node_modules/.bin/agent");
        symlink(outside.path(), package.join("cli")).unwrap();
        symlink("../@scope/agent/cli", &launcher).unwrap();
        assert!(npm_command(root.path(), "@scope/agent").is_err());
        std::fs::remove_file(package.join("cli")).unwrap();
        std::fs::write(package.join("cli"), "script").unwrap();
        std::fs::remove_file(&launcher).unwrap();
        symlink(outside.path(), &launcher).unwrap();
        assert!(npm_command(root.path(), "@scope/agent").is_err());
        std::fs::remove_file(package.join("package.json")).unwrap();
        symlink(outside.path(), package.join("package.json")).unwrap();
        assert!(npm_command(root.path(), "@scope/agent").is_err());
    }
}
