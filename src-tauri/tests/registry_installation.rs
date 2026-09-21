use atte_lib::{
    agent::LaunchKind,
    agent_management::{
        download::{DownloadFuture, Downloader},
        installer::SystemInstaller,
        node_runtime::{NodeRuntime, NodeSource},
        registry::{Binary, Distribution, Registry},
        AgentManagement, ManagementError,
    },
    thread::{ThreadStatus, Threads},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::OsStr,
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

#[cfg(unix)]
fn executable(path: &Path, bytes: &[u8]) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn source_identity_ignores_registry_presentation_fields() {
    let first = binary("https://fixture/agent.zip", "agent", b"agent");
    let mut presentation_only = registry(first.clone());
    presentation_only.agents[0].name = "Renamed".into();
    presentation_only.agents[0].description = "New description".into();
    let original = registry(first);
    assert_eq!(
        original.agents[0]
            .distribution(&atte_lib::agent_management::registry::platform())
            .unwrap()
            .source_identity(),
        presentation_only.agents[0]
            .distribution(&atte_lib::agent_management::registry::platform())
            .unwrap()
            .source_identity()
    );
}

#[test]
fn source_identity_ignores_unknown_distribution_metadata() {
    let original = registry(binary("https://fixture/agent.zip", "agent", b"agent"));
    let mut metadata_only = original.agents[0]
        .distribution(&atte_lib::agent_management::registry::platform())
        .unwrap();
    let Distribution::Binary(binary) = &mut metadata_only else {
        panic!("expected binary distribution");
    };
    binary
        .unknown
        .insert("futureDisplayHint".into(), serde_json::json!("compact"));
    assert_eq!(
        original.agents[0]
            .distribution(&atte_lib::agent_management::registry::platform())
            .unwrap()
            .source_identity(),
        metadata_only.source_identity()
    );
}

#[test]
fn source_identity_changes_with_installation_inputs() {
    let original = registry(binary("https://fixture/agent.zip", "agent", b"agent"));
    let changed = registry(binary(
        "https://fixture/repacked-agent.zip",
        "agent",
        b"agent",
    ));

    assert_ne!(
        original.agents[0]
            .distribution(&atte_lib::agent_management::registry::platform())
            .unwrap()
            .source_identity(),
        changed.agents[0]
            .distribution(&atte_lib::agent_management::registry::platform())
            .unwrap()
            .source_identity()
    );
}

struct Downloads {
    files: HashMap<String, Vec<u8>>,
    count: Arc<AtomicUsize>,
}
impl Downloader for Downloads {
    fn download<'a>(
        &'a self,
        url: &'a str,
        destination: &'a Path,
        _: &'a (dyn Fn(&str) + Send + Sync),
    ) -> DownloadFuture<'a> {
        Box::pin(async move {
            self.count.fetch_add(1, Ordering::SeqCst);
            std::fs::write(
                destination,
                self.files.get(url).ok_or(ManagementError::Network)?,
            )
            .map_err(|_| ManagementError::Install)
        })
    }
}
fn binary(url: &str, cmd: &str, bytes: &[u8]) -> Binary {
    Binary {
        archive: url.into(),
        cmd: cmd.into(),
        args: vec![],
        env: Default::default(),
        sha256: Some(format!("{:x}", Sha256::digest(bytes))),
        unknown: Default::default(),
    }
}
fn registry(binary: Binary) -> Registry {
    Registry::parse(&serde_json::json!({"version":"1.0.0", "agents":[{"id":"unknown-agent","name":"Unknown", "version":"2.0.0", "distribution":{"binary":{atte_lib::agent_management::registry::platform(): binary},"npx":{"package":"fallback@2.0.0"}}}]}).to_string()).unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn runtime_prefers_login_shell_then_process_path_and_re_resolves_to_managed() {
    let root = tempfile::tempdir().unwrap();
    let shell_bin = root.path().join("shell-bin");
    let process_bin = root.path().join("process-bin");
    let program = fixture();
    for directory in [&shell_bin, &process_bin] {
        executable(&directory.join("node"), &program);
        executable(&directory.join("npm"), &program);
    }
    let shell = root.path().join("login-shell");
    executable(
        &shell,
        format!("#!/bin/sh\nprintf '%s' '{}'\n", shell_bin.display()).as_bytes(),
    );
    let runtime_root = root.path().join("runtime");
    let managed = runtime_root.join("node-test");
    executable(&managed.join("bin/node"), &program);
    executable(
        &managed.join("lib/node_modules/npm/bin/npm-cli.js"),
        b"fixture npm",
    );
    let count = Arc::new(AtomicUsize::new(0));
    let downloads = Downloads {
        files: HashMap::new(),
        count: count.clone(),
    };
    let runtime = NodeRuntime::controlled(
        binary("https://fixture/unused.tgz", "", b"unused"),
        "node-test".into(),
        Some(shell),
        Some(process_bin.as_os_str().to_owned()),
    );

    let shell_runtime = runtime
        .resolve(&runtime_root, &downloads, &|_| {})
        .await
        .unwrap();
    assert_eq!(shell_runtime.node, shell_bin.join("node"));
    assert_eq!(shell_runtime.source, NodeSource::System);
    assert!(shell_runtime
        .npm_command()
        .as_std()
        .get_envs()
        .all(|(key, _)| !key.to_string_lossy().starts_with("NPM_CONFIG_")));

    std::fs::remove_file(shell_bin.join("node")).unwrap();
    let process_runtime = runtime
        .resolve(&runtime_root, &downloads, &|_| {})
        .await
        .unwrap();
    assert_eq!(process_runtime.node, process_bin.join("node"));

    std::fs::remove_file(process_bin.join("node")).unwrap();
    let managed_runtime = runtime
        .resolve(&runtime_root, &downloads, &|_| {})
        .await
        .unwrap();
    assert_eq!(managed_runtime.source, NodeSource::Managed);
    let npm = managed_runtime.npm_command();
    let keys: Vec<_> = npm
        .as_std()
        .get_envs()
        .map(|(key, _)| key.to_owned())
        .collect();
    for key in [
        "NPM_CONFIG_USERCONFIG",
        "NPM_CONFIG_GLOBALCONFIG",
        "NPM_CONFIG_CACHE",
    ] {
        assert!(keys.iter().any(|candidate| candidate == OsStr::new(key)));
    }
    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn incompatible_shell_runtime_candidates_continue_to_process_path() {
    let program = fixture();
    for (name, node, npm) in [
        (
            "old-node",
            b"#!/bin/sh\necho v21.9.0\n".as_slice(),
            Some(program.as_slice()),
        ),
        ("missing-npm", program.as_slice(), None),
        (
            "failed-node-probe",
            b"#!/bin/sh\nexit 7\n".as_slice(),
            Some(program.as_slice()),
        ),
        (
            "failed-npm-probe",
            program.as_slice(),
            Some(b"#!/bin/sh\nexit 7\n".as_slice()),
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let bad = root.path().join(name);
        let good = root.path().join("good");
        executable(&bad.join("node"), node);
        if let Some(npm) = npm {
            executable(&bad.join("npm"), npm);
        }
        executable(&good.join("node"), &program);
        executable(&good.join("npm"), &program);
        let shell = root.path().join("shell");
        executable(
            &shell,
            format!("#!/bin/sh\nprintf '%s' '{}'\n", bad.display()).as_bytes(),
        );
        let runtime = NodeRuntime::controlled(
            binary("https://fixture/unused.tgz", "", b"unused"),
            "unused".into(),
            Some(shell),
            Some(good.as_os_str().to_owned()),
        );
        let selected = runtime
            .resolve(
                &root.path().join("runtime"),
                &Downloads {
                    files: HashMap::new(),
                    count: Arc::default(),
                },
                &|_| {},
            )
            .await
            .unwrap();
        assert_eq!(selected.node, good.join("node"), "{name}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn failed_or_timed_out_login_shell_lookup_continues_to_process_path() {
    let program = fixture();
    for (name, shell) in [
        ("spawn-failure", None),
        (
            "timeout",
            Some(b"#!/bin/sh\nexec /bin/sleep 5\n".as_slice()),
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let good = root.path().join("good");
        executable(&good.join("node"), &program);
        executable(&good.join("npm"), &program);
        let shell_path = root.path().join("shell");
        if let Some(shell) = shell {
            executable(&shell_path, shell);
        }
        let selected = NodeRuntime::controlled(
            binary("https://fixture/unused.tgz", "", b"unused"),
            "unused".into(),
            Some(shell_path),
            Some(good.as_os_str().to_owned()),
        )
        .resolve(
            &root.path().join("runtime"),
            &Downloads {
                files: HashMap::new(),
                count: Arc::default(),
            },
            &|_| {},
        )
        .await
        .unwrap();
        assert_eq!(selected.node, good.join("node"), "{name}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn system_npm_uses_a_version_upper_bound_and_allows_lifecycle_scripts() {
    let root = tempfile::tempdir().unwrap();
    let system_bin = root.path().join("system-bin");
    let program = fixture();
    executable(&system_bin.join("node"), &program);
    let arguments = root.path().join("npm-arguments");
    let lifecycle = root.path().join("lifecycle-ran");
    let npm = format!(
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 10.0.0; exit 0; fi\nprintf '%s\\n' \"$@\" > '{}'\nprefix=\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = \"--prefix\" ]; then shift; prefix=$1; fi\n  shift\ndone\npackage=\"$prefix/node_modules/@fixture/agent\"\nmkdir -p \"$package\"\ncp '{}' \"$package/agent.js\"\nprintf '%s' '{{\"name\":\"@fixture/agent\",\"version\":\"3.1.0\",\"bin\":{{\"agent\":\"agent.js\"}}}}' > \"$package/package.json\"\ntouch '{}'\n",
        arguments.display(),
        root.path().join("fixture-agent").display(),
        lifecycle.display(),
    );
    executable(&root.path().join("fixture-agent"), &program);
    executable(&system_bin.join("npm"), npm.as_bytes());
    let count = Arc::new(AtomicUsize::new(0));
    let process_path = std::env::join_paths(std::iter::once(system_bin.clone()).chain(
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
    ))
    .unwrap();
    let runtime = NodeRuntime::controlled(
        binary("https://fixture/unused.tgz", "", b"unused"),
        "unused".into(),
        None,
        Some(process_path),
    );
    let installer = SystemInstaller::new(
        Downloads {
            files: HashMap::new(),
            count: count.clone(),
        },
        runtime.clone(),
    );
    let registry = Registry::parse(
        &serde_json::json!({"version":"1.0.0", "agents":[{
            "id":"system-agent", "name":"System", "version":"3.2.1",
            "distribution":{"npx":{"package":"@fixture/agent@3.2.1"}}
        }]})
        .to_string(),
    )
    .unwrap();
    let manager = AgentManagement::open_with_runtime(root.path(), runtime.clone()).unwrap();
    manager.set_registry(registry).unwrap();
    let threads = Threads::new(vec![]);
    manager
        .install("system-agent", &threads, &installer, &|_| {})
        .await
        .unwrap();

    let installed = manager.catalog(&threads).unwrap();
    assert_eq!(installed[0].installed_version.as_deref(), Some("3.1.0"));
    let arguments = std::fs::read_to_string(arguments).unwrap();
    assert!(arguments.contains("@fixture/agent@0.0.0 - 3.2.1"));
    assert!(!arguments.contains("--ignore-scripts"));
    assert!(lifecycle.exists());
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let installation = atte_lib::storage::Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .installations()
        .unwrap()
        .remove(0);
    assert_eq!(installation.definition.launch_kind, LaunchKind::Node);
    let manifest =
        std::fs::read_to_string(installation.artifact.join("installation.json")).unwrap();
    assert!(!manifest.contains(&system_bin.to_string_lossy().to_string()));
    assert!(
        manager
            .authenticate("system-agent", None, &threads)
            .await
            .unwrap()
            .connected
    );
    threads.shutdown().await;
    drop(threads);
    drop(manager);

    let manager = AgentManagement::open_with_runtime(root.path(), runtime).unwrap();
    let restored = Threads::new(vec![]);
    manager.restore(&restored).unwrap();
    let thread = restored
        .create_for_agent(root.path(), "system-agent")
        .unwrap();
    restored.connect(thread.id).unwrap();
    wait_ready(&restored, thread.id).await;
    restored.send_message(thread.id, "system".into()).unwrap();
    wait_ready(&restored, thread.id).await;
    assert_eq!(
        restored.get(thread.id).unwrap().turns[0].response,
        "Hello world"
    );
    restored.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn failed_system_npm_install_does_not_download_or_retry_with_managed_npm() {
    let root = tempfile::tempdir().unwrap();
    let system_bin = root.path().join("system-bin");
    executable(&system_bin.join("node"), &fixture());
    executable(
        &system_bin.join("npm"),
        b"#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 10.0.0; exit 0; fi\nexit 9\n",
    );
    let count = Arc::new(AtomicUsize::new(0));
    let installer = SystemInstaller::new(
        Downloads {
            files: HashMap::new(),
            count: count.clone(),
        },
        NodeRuntime::controlled(
            binary("https://fixture/managed.tgz", "", b"managed"),
            "managed".into(),
            None,
            Some(system_bin.as_os_str().to_owned()),
        ),
    );
    let manager = AgentManagement::open(root.path()).unwrap();
    manager
        .set_registry(
            Registry::parse(
                r#"{"version":"1.0.0","agents":[{"id":"system-agent","name":"System","version":"1.0.0","distribution":{"npx":{"package":"fixture@1.0.0"}}}]}"#,
            )
            .unwrap(),
        )
        .unwrap();

    assert!(manager
        .install("system-agent", &Threads::new(vec![]), &installer, &|_| {},)
        .await
        .is_err());
    assert_eq!(count.load(Ordering::SeqCst), 0);
}
fn tar(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (path, bytes) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder.append_data(&mut header, path, *bytes).unwrap();
    }
    builder.into_inner().unwrap()
}
fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}
fn bzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}
fn zip(path: &str, bytes: &[u8]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file(path, zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(bytes).unwrap();
    writer.finish().unwrap().into_inner()
}

#[tokio::test]
async fn supported_binary_formats_preserve_registry_launch_metadata_and_restore() {
    let program = b"executable fixture";
    let tar = tar(&[("bin/agent", program)]);
    for (extension, bytes) in [
        ("zip", zip("bin/agent", program)),
        ("tar.gz", gzip(&tar)),
        ("tgz", gzip(&tar)),
        ("tar.bz2", bzip(&tar)),
        ("tbz2", bzip(&tar)),
        ("exe", program.to_vec()),
    ] {
        let root = tempfile::tempdir().unwrap();
        let url = format!("https://fixture/agent.{extension}");
        let mut binary = binary(&url, "./bin/agent", &bytes);
        binary.args = vec!["--acp".into()];
        binary.env.insert("MODE".into(), "acp".into());
        let manager = AgentManagement::open(root.path()).unwrap();
        manager.set_registry(registry(binary)).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let installer = SystemInstaller::new(
            Downloads {
                files: HashMap::from([(url, bytes)]),
                count: count.clone(),
            },
            NodeRuntime::default(),
        );
        let threads = Threads::new(vec![]);
        manager
            .install("unknown-agent", &threads, &installer, &|_| {})
            .await
            .unwrap();
        manager
            .install("unknown-agent", &threads, &installer, &|_| {})
            .await
            .unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(manager);
        let manager = AgentManagement::open(root.path()).unwrap();
        let threads = Threads::new(vec![]);
        manager.restore(&threads).unwrap();
        assert_eq!(threads.prepared_agents()[0].id, "unknown-agent");
        let installs = atte_lib::storage::Store::open(&root.path().join("atte.sqlite"))
            .unwrap()
            .installations()
            .unwrap();
        assert_eq!(
            installs[0].artifact.parent().unwrap().file_name().unwrap(),
            "unknown-agent"
        );
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(installs[0].artifact.join("installation.json")).unwrap(),
        )
        .unwrap();
        let mut keys: Vec<_> = manifest
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "installedVersion",
                "launch",
                "registryVersion",
                "sourceIdentity"
            ]
        );
        assert_eq!(manifest["registryVersion"], "2.0.0");
        assert!(manifest.get("agentId").is_none());
        assert!(manifest.get("active").is_none());
        assert!(manifest["launch"].to_string().contains("artifact"));
        assert!(!manifest["launch"]
            .to_string()
            .contains(root.path().to_string_lossy().as_ref()));
        assert_eq!(
            std::fs::read(&installs[0].definition.command).unwrap(),
            program
        );
        assert_eq!(installs[0].definition.args, ["--acp"]);
        assert_eq!(installs[0].definition.env["MODE"], "acp");
    }
}

#[tokio::test]
async fn bad_downloads_do_not_replace_a_working_installation_or_fall_back_to_npm() {
    let root = tempfile::tempdir().unwrap();
    let threads = Threads::new(vec![]);
    let manager = AgentManagement::open(root.path()).unwrap();
    let good = b"good".to_vec();
    let url = "https://fixture/agent";
    manager
        .set_registry(registry(binary(url, "agent", &good)))
        .unwrap();
    let installer = SystemInstaller::new(
        Downloads {
            files: HashMap::from([(url.into(), good)]),
            count: Arc::default(),
        },
        NodeRuntime::default(),
    );
    manager
        .install("unknown-agent", &threads, &installer, &|_| {})
        .await
        .unwrap();
    let original = manager.catalog(&threads).unwrap()[0].artifact.clone();
    let mut link_tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_size(0);
    header.set_mode(0o755);
    header.set_cksum();
    link_tar
        .append_link(&mut header, "agent", "../../escape")
        .unwrap();
    for (url, bytes, bad_checksum) in [
        ("https://fixture/bad.zip", zip("../escape", b"bad"), false),
        (
            "https://fixture/link.tgz",
            gzip(&link_tar.into_inner().unwrap()),
            false,
        ),
        ("https://fixture/broken.zip", b"broken".to_vec(), false),
        ("https://fixture/checksum", b"wrong".to_vec(), true),
    ] {
        let mut binary = binary(url, "agent", &bytes);
        if bad_checksum {
            binary.sha256 = Some("00".repeat(32));
        }
        let updated_registry = registry(binary);
        manager.set_registry(updated_registry.clone()).unwrap();
        let installer = SystemInstaller::new(
            Downloads {
                files: HashMap::from([(url.into(), bytes)]),
                count: Arc::default(),
            },
            NodeRuntime::default(),
        );
        assert!(manager
            .install("unknown-agent", &threads, &installer, &|_| {})
            .await
            .is_ok());
        let empty_root = tempfile::tempdir().unwrap();
        let empty_manager = AgentManagement::open(empty_root.path()).unwrap();
        empty_manager.set_registry(updated_registry).unwrap();
        assert!(empty_manager
            .install("unknown-agent", &Threads::new(vec![]), &installer, &|_| {})
            .await
            .is_err());
        assert!(!empty_manager.catalog(&Threads::new(vec![])).unwrap()[0].installed);
        assert_eq!(manager.catalog(&threads).unwrap()[0].artifact, original);
        assert_eq!(
            std::fs::read_dir(root.path().join("agents"))
                .unwrap()
                .count(),
            1
        );
    }
}

fn fixture() -> Vec<u8> {
    let result = std::process::Command::new(env!("CARGO"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "build",
            "--locked",
            "--example",
            "acp-agent-fixture",
            "--message-format=json",
        ])
        .output()
        .unwrap();
    assert!(result.status.success());
    let path = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find_map(|message| message["executable"].as_str().map(str::to_owned))
        .unwrap();
    std::fs::read(path).unwrap()
}

#[tokio::test]
async fn managed_runtime_retry_reuse_npm_install_authentication_and_two_responses() {
    let root = tempfile::tempdir().unwrap();
    let url = "https://fixture/node.tgz";
    let bytes = gzip(&tar(&[
        ("node-test/bin/node", &fixture()),
        (
            "node-test/lib/node_modules/npm/bin/npm-cli.js",
            b"fixture npm",
        ),
    ]));
    let runtime = binary(url, "", &bytes);
    let manager = AgentManagement::open(root.path()).unwrap();
    let login = root.path().join("login");
    let registry = Registry::parse(&serde_json::json!({"version":"1.0.0", "agents":[{"id":"unexpected-provider","name":"Unexpected", "version":"1.0.0", "distribution":{"npx":{"package":"@fixture/agent@3.2.1", "env":{"AUTH_FILE":login}}}}]}).to_string()).unwrap();
    manager.set_registry(registry.clone()).unwrap();
    let threads = Threads::new(vec![]);
    let failed = SystemInstaller::new(
        Downloads {
            files: HashMap::new(),
            count: Arc::default(),
        },
        NodeRuntime::managed(runtime.clone(), "node-test".into()),
    );
    assert!(manager
        .install("unexpected-provider", &threads, &failed, &|_| {})
        .await
        .is_err());
    assert!(!manager.catalog(&threads).unwrap()[0].installed);
    let count = Arc::new(AtomicUsize::new(0));
    let installer = SystemInstaller::new(
        Downloads {
            files: HashMap::from([(url.into(), bytes)]),
            count: count.clone(),
        },
        NodeRuntime::managed(runtime, "node-test".into()),
    );
    manager
        .install("unexpected-provider", &threads, &installer, &|_| {})
        .await
        .unwrap();
    let mut registry2 = registry;
    registry2.agents[0].id = "second-provider".into();
    manager.set_registry(registry2).unwrap();
    manager
        .install("second-provider", &threads, &installer, &|_| {})
        .await
        .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(
        manager.catalog(&threads).unwrap()[0]
            .installed_version
            .as_deref(),
        Some("3.2.1")
    );
    let state = manager
        .authenticate("unexpected-provider", None, &threads)
        .await
        .unwrap();
    assert!(!state.authenticated);
    assert!(manager
        .authenticate("unexpected-provider", Some("fixture-denied"), &threads)
        .await
        .is_err());
    assert!(
        manager
            .authenticate("unexpected-provider", Some("fixture-login"), &threads)
            .await
            .unwrap()
            .authenticated
    );
    let thread = threads
        .create_for_agent(root.path(), "unexpected-provider")
        .unwrap();
    threads.connect(thread.id).unwrap();
    for message in ["first", "second"] {
        wait_ready(&threads, thread.id).await;
        threads.send_message(thread.id, message.into()).unwrap();
    }
    wait_ready(&threads, thread.id).await;
    assert_eq!(threads.get(thread.id).unwrap().turns.len(), 2);
    threads.shutdown().await;
    drop(manager);
    let manager = AgentManagement::open(root.path()).unwrap();
    let restored = Threads::new(vec![]);
    manager.restore(&restored).unwrap();
    assert_eq!(restored.prepared_agents().len(), 2);
}

async fn wait_ready(threads: &Threads, id: uuid::Uuid) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state = threads.get(id).unwrap();
            if matches!(state.status, ThreadStatus::SessionReady) {
                break;
            }
            assert_ne!(state.status, ThreadStatus::Failed, "{state:?}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn binary_node_entrypoint_is_resolved_from_installation_not_working_folder() {
    let root = tempfile::tempdir().unwrap();
    let node_url = "https://fixture/node.tgz";
    let node_bytes = gzip(&tar(&[
        ("node-test/bin/node", &fixture()),
        ("node-test/lib/node_modules/npm/bin/npm-cli.js", b"npm"),
    ]));
    let agent_url = "https://fixture/agent.zip";
    let agent_bytes = zip("index.js", b"script");
    let runtime = NodeRuntime::managed(binary(node_url, "", &node_bytes), "node-test".into());
    let installer = SystemInstaller::new(
        Downloads {
            files: HashMap::from([
                (node_url.into(), node_bytes),
                (agent_url.into(), agent_bytes.clone()),
            ]),
            count: Arc::default(),
        },
        runtime,
    );
    let mut descriptor = binary(agent_url, "node", &agent_bytes);
    descriptor.args = vec!["index.js".into(), "--acp".into()];
    let manager = AgentManagement::open(root.path()).unwrap();
    manager.set_registry(registry(descriptor)).unwrap();
    manager
        .install("unknown-agent", &Threads::new(vec![]), &installer, &|_| {})
        .await
        .unwrap();
    let installations = atte_lib::storage::Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .installations()
        .unwrap();
    assert_eq!(installations[0].definition.launch_kind, LaunchKind::Node);
    assert!(installations[0].definition.command.is_absolute());
    assert_eq!(
        std::fs::read(&installations[0].definition.command).unwrap(),
        b"script"
    );
    assert_eq!(installations[0].definition.args, ["--acp"]);
    let manifest =
        std::fs::read_to_string(installations[0].artifact.join("installation.json")).unwrap();
    assert!(!manifest.contains("node-test/bin/node"));
}

#[tokio::test]
async fn uninstall_stops_live_acp_and_removes_files_before_returning() {
    let root = tempfile::tempdir().unwrap();
    let url = "https://fixture/agent";
    let bytes = fixture();
    let manager = AgentManagement::open(root.path()).unwrap();
    manager
        .set_registry(registry(binary(url, "agent", &bytes)))
        .unwrap();
    let installer = SystemInstaller::new(
        Downloads {
            files: HashMap::from([(url.into(), bytes)]),
            count: Arc::default(),
        },
        NodeRuntime::default(),
    );
    let threads = Threads::new(vec![]);
    manager
        .install("unknown-agent", &threads, &installer, &|_| {})
        .await
        .unwrap();
    let artifact = manager.catalog(&threads).unwrap()[0]
        .artifact
        .clone()
        .unwrap();
    let draft = threads
        .create_for_agent(root.path(), "unknown-agent")
        .unwrap();
    threads.connect(draft.id).unwrap();
    wait_ready(&threads, draft.id).await;
    threads.send_message(draft.id, "first".into()).unwrap();
    wait_ready(&threads, draft.id).await;
    manager.uninstall("unknown-agent", &threads).await.unwrap();
    assert!(threads.send_message(draft.id, "second".into()).is_err());
    assert!(threads.connect(draft.id).is_err());
    let state = threads.get(draft.id).unwrap();
    assert_eq!(state.turns.len(), 1);
    assert_eq!(state.turns[0].response, "Hello world");
    assert_eq!(
        state.failure,
        Some(atte_lib::thread::ConnectionFailure::AgentRemoved)
    );
    assert!(!artifact.exists());
    assert!(threads.prepared_agents().is_empty());
    manager
        .install("unknown-agent", &threads, &installer, &|_| {})
        .await
        .unwrap();
    let replacement = manager.catalog(&threads).unwrap()[0]
        .artifact
        .clone()
        .unwrap();
    assert!(replacement.exists());
    assert_ne!(artifact, replacement);
    threads.connect(draft.id).unwrap();
    wait_ready(&threads, draft.id).await;
    assert_eq!(threads.get(draft.id).unwrap().session_id, state.session_id);
    let next = threads
        .create_for_agent(root.path(), "unknown-agent")
        .unwrap();
    threads.connect(next.id).unwrap();
    wait_ready(&threads, next.id).await;
    threads.shutdown().await;
    drop(threads);
    drop(manager);
    let manager = AgentManagement::open(root.path()).unwrap();
    assert!(!artifact.exists());
    assert!(manager.catalog(&Threads::new(vec![])).unwrap()[0].installed);
}
