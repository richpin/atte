use atte_lib::{
    agent_management::{
        download::{DownloadFuture, Downloader},
        installer::SystemInstaller,
        node_runtime::NodeRuntime,
        registry::{Binary, Registry},
        AgentManagement, ManagementError,
    },
    thread::{ThreadStatus, Threads},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

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
    }
}
fn registry(binary: Binary) -> Registry {
    Registry::parse(&serde_json::json!({"version":"1.0.0", "agents":[{"id":"unknown-agent","name":"Unknown", "version":"2.0.0", "distribution":{"binary":{atte_lib::agent_management::registry::platform(): binary},"npx":{"package":"fallback@2.0.0"}}}]}).to_string()).unwrap()
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
    assert!(Path::new(&installations[0].definition.args[0]).is_absolute());
    assert_eq!(
        std::fs::read(&installations[0].definition.args[0]).unwrap(),
        b"script"
    );
    assert_eq!(installations[0].definition.args[1], "--acp");
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
    assert_eq!(
        threads.get(draft.id).unwrap().remote_session_id,
        state.remote_session_id
    );
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
