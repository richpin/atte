use atte_lib::{
    agent::AgentDefinition,
    storage::{Installation, Store},
};

#[test]
fn installation_survives_reopening_the_store() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("atte.sqlite");
    let store = Store::open(&path).unwrap();
    let installation = Installation {
        definition: AgentDefinition {
            id: "codex-acp".into(),
            name: "Codex".into(),
            launch_kind: Default::default(),
            command: "/installed/node".into(),
            args: vec!["/installed/adapter.js".into()],
            env: Default::default(),
            node_runtime: None,
        },
        version: "1.12.0".into(),
        artifact: root.path().join("codex-acp"),
    };
    store.save_installation(&installation).unwrap();
    drop(store);
    let restored = Store::open(&path).unwrap().installations().unwrap();
    assert_eq!(restored[0].version, "1.12.0");
    assert_eq!(restored[0].definition.args, vec!["/installed/adapter.js"]);
}

#[test]
fn initializes_an_empty_database_and_reopens_schema_one() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("atte.sqlite");
    let connection = rusqlite::Connection::open(&path).unwrap();
    assert!(Store::open(&path)
        .unwrap()
        .installations()
        .unwrap()
        .is_empty());
    assert!(Store::open(&path)
        .unwrap()
        .installations()
        .unwrap()
        .is_empty());
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
    let tables: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(tables, ["agents", "app_metadata", "threads"]);
}

#[test]
fn rejects_a_future_schema_without_modifying_it() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("atte.sqlite");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    assert!(matches!(
        Store::open(&path),
        Err(atte_lib::storage::StorageError::NewerSchema)
    ));
}

use atte_lib::{
    agent_management::{
        installer::{InstallFuture, Installer},
        registry::{Distribution, Registry, RegistryAgent},
        AgentManagement, ManagementError,
    },
    thread::Threads,
};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

struct ControlledInstaller {
    fail: bool,
}

struct CountingInstaller {
    count: AtomicUsize,
}

struct ConcurrentInstaller {
    current: AtomicUsize,
    maximum: AtomicUsize,
    started: tokio::sync::Notify,
    release: tokio::sync::Semaphore,
}

impl Installer for ConcurrentInstaller {
    fn install<'a>(
        &'a self,
        id: &'a str,
        entry: &'a RegistryAgent,
        _: &'a Distribution,
        root: &'a Path,
        _: &'a (dyn Fn(&str) + Send + Sync),
    ) -> InstallFuture<'a> {
        Box::pin(async move {
            let current = self.current.fetch_add(1, Ordering::SeqCst) + 1;
            self.maximum.fetch_max(current, Ordering::SeqCst);
            self.started.notify_waiters();
            let permit = self.release.acquire().await.unwrap();
            permit.forget();
            self.current.fetch_sub(1, Ordering::SeqCst);
            let artifact = root
                .join(id)
                .join(format!(".staging-fixture-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&artifact).unwrap();
            std::fs::write(artifact.join("fixture"), "installation").unwrap();
            Ok(Installation {
                definition: AgentDefinition {
                    id: id.into(),
                    name: entry.name.clone(),
                    launch_kind: Default::default(),
                    command: artifact.join("fixture"),
                    args: vec![],
                    env: Default::default(),
                    node_runtime: None,
                },
                version: entry.version.clone(),
                artifact,
            })
        })
    }
}
impl Installer for ControlledInstaller {
    fn install<'a>(
        &'a self,
        id: &'a str,
        entry: &'a RegistryAgent,
        _distribution: &'a Distribution,
        root: &'a Path,
        progress: &'a (dyn Fn(&str) + Send + Sync),
    ) -> InstallFuture<'a> {
        Box::pin(async move {
            progress("installing");
            if self.fail {
                return Err(ManagementError::Install);
            }
            let artifact = root
                .join(id)
                .join(format!(".staging-fixture-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&artifact).unwrap();
            std::fs::write(artifact.join("fixture"), "installation").unwrap();
            Ok(Installation {
                definition: AgentDefinition {
                    id: id.into(),
                    name: entry.name.clone(),
                    launch_kind: Default::default(),
                    command: artifact.join("fixture"),
                    args: vec![],
                    env: Default::default(),
                    node_runtime: None,
                },
                version: entry.version.clone(),
                artifact,
            })
        })
    }
}

impl Installer for CountingInstaller {
    fn install<'a>(
        &'a self,
        id: &'a str,
        entry: &'a RegistryAgent,
        _: &'a Distribution,
        root: &'a Path,
        _: &'a (dyn Fn(&str) + Send + Sync),
    ) -> InstallFuture<'a> {
        Box::pin(async move {
            self.count.fetch_add(1, Ordering::SeqCst);
            let artifact = root
                .join(id)
                .join(format!(".staging-fixture-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&artifact).unwrap();
            std::fs::write(artifact.join("fixture"), "installation").unwrap();
            Ok(Installation {
                definition: AgentDefinition {
                    id: id.into(),
                    name: entry.name.clone(),
                    launch_kind: Default::default(),
                    command: artifact.join("fixture"),
                    args: vec![],
                    env: Default::default(),
                    node_runtime: None,
                },
                version: entry.version.clone(),
                artifact,
            })
        })
    }
}

fn registry() -> Registry {
    Registry::parse(include_str!("fixtures/registry.json")).unwrap()
}

#[tokio::test]
async fn failed_installation_can_retry_and_only_success_survives_restart() {
    let root = tempfile::tempdir().unwrap();
    let management = AgentManagement::open(root.path()).unwrap();
    management.set_registry(registry()).unwrap();
    let threads = Threads::new(vec![]);
    assert!(management
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: true },
            &|_| {}
        )
        .await
        .is_err());
    assert!(
        !management
            .catalog(&threads)
            .unwrap()
            .iter()
            .find(|agent| agent.id == "codex-acp")
            .unwrap()
            .installed
    );
    assert!(threads.prepared_agents().is_empty());
    management
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    assert_eq!(threads.prepared_agents()[0].id, "codex-acp");
    drop(management);
    let restored = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    restored.restore(&threads).unwrap();
    assert_eq!(threads.prepared_agents()[0].id, "codex-acp");
    let catalog = restored.catalog(&threads).unwrap();
    let codex = catalog
        .iter()
        .find(|agent| agent.id == "codex-acp")
        .unwrap();
    assert!(codex.installed);
    assert!(!codex.authentication.authenticated);
}

#[test]
fn registry_selects_platform_binary_or_npm_and_excludes_other_agents() {
    let registry = registry();
    assert!(matches!(
        registry
            .target("codex-acp")
            .unwrap()
            .distribution("darwin-aarch64"),
        Some(Distribution::Npm(_))
    ));
    assert!(matches!(
        registry
            .target("antigravity-acp")
            .unwrap()
            .distribution("darwin-aarch64"),
        Some(Distribution::Binary(_))
    ));
    assert!(registry
        .target("antigravity-acp")
        .unwrap()
        .distribution("darwin-x86_64")
        .is_none());
    assert!(registry.target("other").is_none());
}

#[test]
fn catalog_excludes_uninstalled_agents_without_a_supported_distribution() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    manager.set_registry(registry()).unwrap();

    let ids: Vec<_> = manager
        .catalog(&Threads::new(vec![]))
        .unwrap()
        .into_iter()
        .map(|agent| agent.id)
        .collect();

    assert_eq!(ids, ["antigravity-acp", "claude-acp", "codex-acp"]);
}

#[test]
fn unknown_distribution_data_survives_storage_round_trip() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    manager.set_registry(registry()).unwrap();
    drop(manager);

    let stored = Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .agents()
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == "future-runtime")
        .unwrap()
        .registry
        .unwrap();
    let json = serde_json::to_value(stored).unwrap();

    assert_eq!(
        json["distribution"]["future"],
        serde_json::json!({"nested": [true, 7, "preserve-me"]})
    );
    let codex = Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .agents()
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == "codex-acp")
        .unwrap()
        .registry
        .unwrap();
    assert_eq!(
        serde_json::to_value(codex).unwrap()["distribution"]["npx"]["futurePolicy"],
        serde_json::json!({"mode": "preserve"})
    );
}

#[tokio::test]
async fn unknown_registry_agent_survives_offline_restart_and_registry_removal() {
    let root = tempfile::tempdir().unwrap();
    let management = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    let mut registry = registry();
    let mut added = registry.agents[0].clone();
    added.id = "new-provider".into();
    added.name = "New provider".into();
    registry.agents.push(added);
    management.set_registry(registry).unwrap();
    assert_eq!(management.catalog(&threads).unwrap().len(), 4);
    management
        .install(
            "new-provider",
            &threads,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    drop(management);
    let management = AgentManagement::open(root.path()).unwrap();
    assert_eq!(management.catalog(&threads).unwrap().len(), 4);
    management
        .set_registry(Registry::parse(r#"{"version":"1.0.0","agents":[]}"#).unwrap())
        .unwrap();
    let catalog = management.catalog(&threads).unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].id, "new-provider");
    assert!(catalog[0].installed);
    assert!(catalog[0].distribution.is_none());
}

#[tokio::test]
async fn cached_catalog_survives_failed_refresh_and_reuses_a_good_installation() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    manager.set_registry(registry()).unwrap();
    manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    assert!(manager
        .refresh_from("http://127.0.0.1:1", true)
        .await
        .is_err());
    assert_eq!(manager.catalog(&threads).unwrap().len(), 3);
    manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: true },
            &|_| {},
        )
        .await
        .unwrap();
    manager
        .refresh_from("http://127.0.0.1:1", false)
        .await
        .unwrap();
}

#[tokio::test]
async fn automatic_update_promotes_when_agent_is_idle_and_removes_previous_installation() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    manager.set_registry(registry()).unwrap();
    manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    let previous = manager
        .catalog(&threads)
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == "codex-acp")
        .unwrap()
        .artifact
        .unwrap();

    let mut newer = registry();
    let entry = newer
        .agents
        .iter_mut()
        .find(|entry| entry.id == "codex-acp")
        .unwrap();
    entry.version = "2.0.0".into();
    entry.distribution.npx.as_mut().unwrap().package =
        "@agentclientprotocol/codex-acp@2.0.0".into();
    manager.set_registry(newer).unwrap();
    manager
        .prepare_updates(&threads, &ControlledInstaller { fail: false })
        .await
        .unwrap();

    let updated = manager
        .catalog(&threads)
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == "codex-acp")
        .unwrap();
    assert_eq!(updated.installed_version.as_deref(), Some("2.0.0"));
    assert_ne!(updated.artifact.as_deref(), Some(previous.as_path()));
    assert!(!previous.exists());
}

#[tokio::test]
async fn reap_failure_preserves_active_and_pending_until_the_update_retries() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    manager.set_registry(registry()).unwrap();
    manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    let old = manager
        .catalog(&threads)
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == "codex-acp")
        .unwrap()
        .artifact
        .unwrap();
    let mut newer = registry();
    let entry = newer
        .agents
        .iter_mut()
        .find(|entry| entry.id == "codex-acp")
        .unwrap();
    entry.version = "2.0.0".into();
    entry.distribution.npx.as_mut().unwrap().package =
        "@agentclientprotocol/codex-acp@2.0.0".into();
    manager.set_registry(newer).unwrap();
    threads.fail_next_runtime_stop_for_test();

    manager
        .prepare_updates(&threads, &ControlledInstaller { fail: false })
        .await
        .unwrap();
    let store = Store::open(&root.path().join("atte.sqlite")).unwrap();
    let failed = store
        .agents()
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == "codex-acp")
        .unwrap();
    let pending = failed.pending.as_ref().unwrap().artifact.clone();
    assert_eq!(
        (
            failed
                .installation
                .as_ref()
                .map(|item| item.version.as_str()),
            failed.pending.as_ref().map(|item| item.version.as_str()),
            old.exists(),
            pending.exists(),
        ),
        (Some("1.12.0"), Some("2.0.0"), true, true)
    );

    manager
        .prepare_updates(&threads, &ControlledInstaller { fail: false })
        .await
        .unwrap();
    let recovered = store
        .agents()
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == "codex-acp")
        .unwrap();
    assert_eq!(
        (
            recovered
                .installation
                .as_ref()
                .map(|item| item.version.as_str()),
            recovered.pending.is_none(),
            old.exists(),
            pending.exists(),
        ),
        (Some("2.0.0"), true, false, true)
    );
}

#[tokio::test]
async fn same_version_source_change_updates_once() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    let mut changed = registry();
    manager.set_registry(changed.clone()).unwrap();
    manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    changed.agents[1].distribution.npx.as_mut().unwrap().package =
        "@agentclientprotocol/codex-acp@repacked".into();
    manager.set_registry(changed).unwrap();
    let installer = CountingInstaller {
        count: AtomicUsize::new(0),
    };

    manager.prepare_updates(&threads, &installer).await.unwrap();
    manager.prepare_updates(&threads, &installer).await.unwrap();

    assert_eq!(installer.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn automatic_updates_prepare_at_most_three_agents_concurrently() {
    let root = tempfile::tempdir().unwrap();
    let manager = Arc::new(AgentManagement::open(root.path()).unwrap());
    let threads = Arc::new(Threads::new(vec![]));
    let template = registry().agents[1].clone();
    let mut initial = Registry::parse(r#"{"version":"1.0.0","agents":[]}"#).unwrap();
    for index in 0..4 {
        let mut entry = template.clone();
        entry.id = format!("agent-{index}");
        entry.version = "1.0.0".into();
        entry.distribution.npx.as_mut().unwrap().package = format!("fixture-{index}@1.0.0");
        initial.agents.push(entry);
    }
    manager.set_registry(initial.clone()).unwrap();
    for index in 0..4 {
        manager
            .install(
                &format!("agent-{index}"),
                &threads,
                &ControlledInstaller { fail: false },
                &|_| {},
            )
            .await
            .unwrap();
    }
    for entry in &mut initial.agents {
        entry.version = "2.0.0".into();
        entry.distribution.npx.as_mut().unwrap().package = format!("{}@2.0.0", entry.id);
    }
    manager.set_registry(initial).unwrap();
    let installer = Arc::new(ConcurrentInstaller {
        current: AtomicUsize::new(0),
        maximum: AtomicUsize::new(0),
        started: tokio::sync::Notify::new(),
        release: tokio::sync::Semaphore::new(0),
    });
    let task = {
        let manager = manager.clone();
        let threads = threads.clone();
        let installer = installer.clone();
        tokio::spawn(async move { manager.prepare_updates(&threads, installer.as_ref()).await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if installer.current.load(Ordering::SeqCst) == 3 {
                break;
            }
            installer.started.notified().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(installer.maximum.load(Ordering::SeqCst), 3);
    let overlapping = {
        let manager = manager.clone();
        let threads = threads.clone();
        let installer = installer.clone();
        tokio::spawn(async move { manager.prepare_updates(&threads, installer.as_ref()).await })
    };
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(100),
        installer.started.notified()
    )
    .await
    .is_err());
    assert_eq!(installer.maximum.load(Ordering::SeqCst), 3);
    installer.release.add_permits(8);
    task.await.unwrap().unwrap();
    overlapping.await.unwrap().unwrap();
    assert_eq!(installer.maximum.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn uninstall_cancels_automatic_preparation_and_removes_the_selected_agent() {
    let root = tempfile::tempdir().unwrap();
    let manager = Arc::new(AgentManagement::open(root.path()).unwrap());
    let threads = Arc::new(Threads::new(vec![]));
    manager.set_registry(registry()).unwrap();
    manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    let mut newer = registry();
    let entry = newer
        .agents
        .iter_mut()
        .find(|entry| entry.id == "codex-acp")
        .unwrap();
    entry.version = "2.0.0".into();
    entry.distribution.npx.as_mut().unwrap().package =
        "@agentclientprotocol/codex-acp@2.0.0".into();
    manager.set_registry(newer).unwrap();
    let installer = Arc::new(ConcurrentInstaller {
        current: AtomicUsize::new(0),
        maximum: AtomicUsize::new(0),
        started: tokio::sync::Notify::new(),
        release: tokio::sync::Semaphore::new(0),
    });
    let preparation = {
        let manager = manager.clone();
        let threads = threads.clone();
        let installer = installer.clone();
        tokio::spawn(async move { manager.prepare_updates(&threads, installer.as_ref()).await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while installer.current.load(Ordering::SeqCst) == 0 {
            installer.started.notified().await;
        }
    })
    .await
    .unwrap();

    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        manager.uninstall("codex-acp", &threads),
    )
    .await
    .unwrap()
    .unwrap();
    preparation.await.unwrap().unwrap();

    let removed = manager
        .catalog(&threads)
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == "codex-acp")
        .unwrap();
    assert!(!removed.installed);
}

#[tokio::test]
async fn failed_repair_preserves_the_selected_installation() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    manager.set_registry(registry()).unwrap();
    manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    let selected = manager
        .catalog(&threads)
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == "codex-acp")
        .unwrap();
    let artifact = selected.artifact.unwrap();
    std::fs::remove_file(artifact.join("fixture")).unwrap();

    assert!(manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: true },
            &|_| {},
        )
        .await
        .is_err());

    let preserved = manager
        .catalog(&threads)
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == "codex-acp")
        .unwrap();
    assert_eq!(preserved.installed_version.as_deref(), Some("1.12.0"));
    assert_eq!(preserved.artifact.as_deref(), Some(artifact.as_path()));
    assert!(artifact.exists());
}

#[tokio::test]
async fn reopening_promotes_pending_and_cleans_staging_orphans_but_keeps_runtime() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    manager.set_registry(registry()).unwrap();
    manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    let active = manager
        .catalog(&threads)
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == "codex-acp")
        .unwrap()
        .artifact
        .unwrap();
    drop(manager);

    let agent_root = active.parent().unwrap();
    let pending = agent_root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&pending).unwrap();
    std::fs::copy(active.join("fixture"), pending.join("fixture")).unwrap();
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(active.join("installation.json")).unwrap()).unwrap();
    manifest["installedVersion"] = "2.0.0".into();
    std::fs::write(
        pending.join("installation.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let orphan = agent_root.join(uuid::Uuid::new_v4().to_string());
    let staging = agent_root.join(".staging-crashed");
    std::fs::create_dir_all(&orphan).unwrap();
    std::fs::create_dir_all(&staging).unwrap();
    let runtime = root.path().join("agents/runtime/cache");
    std::fs::create_dir_all(&runtime).unwrap();
    std::fs::write(runtime.join("keep"), "shared").unwrap();
    let store = Store::open(&root.path().join("atte.sqlite")).unwrap();
    store
        .save_pending(&Installation {
            definition: AgentDefinition {
                id: "codex-acp".into(),
                name: "Codex".into(),
                launch_kind: Default::default(),
                command: pending.join("fixture"),
                args: vec![],
                env: Default::default(),
                node_runtime: None,
            },
            version: "2.0.0".into(),
            artifact: pending.clone(),
        })
        .unwrap();
    drop(store);

    let reopened = AgentManagement::open(root.path()).unwrap();
    let installed = reopened
        .catalog(&Threads::new(vec![]))
        .unwrap()
        .into_iter()
        .find(|agent| agent.id == "codex-acp")
        .unwrap();
    assert_eq!(installed.installed_version.as_deref(), Some("2.0.0"));
    assert_eq!(installed.artifact.as_deref(), Some(pending.as_path()));
    assert!(!active.exists());
    assert!(!orphan.exists());
    assert!(!staging.exists());
    assert_eq!(
        std::fs::read_to_string(runtime.join("keep")).unwrap(),
        "shared"
    );
}

#[test]
fn catalog_preserves_optional_registry_links_and_icons_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let registry = serde_json::from_value(serde_json::json!({
        "version": "1.0.0",
        "agents": [
            {"id": "with-icon", "name": "With icon", "version": "1", "distribution": {"npx": {"package": "with-icon@1.0.0"}},
             "icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/example.svg",
             "website": "https://example.com/with-icon",
             "repository": "https://github.com/example/with-icon"},
            {"id": "without-icon", "name": "Without icon", "version": "1", "distribution": {"npx": {"package": "without-icon@1.0.0"}}}
        ]
    }))
    .unwrap();
    manager.set_registry(registry).unwrap();
    drop(manager);
    let manager = AgentManagement::open(root.path()).unwrap();
    let catalog = serde_json::to_value(manager.catalog(&Threads::new(vec![])).unwrap()).unwrap();
    assert_eq!(
        catalog[0]["icon"],
        "https://cdn.agentclientprotocol.com/registry/v1/latest/example.svg"
    );
    assert_eq!(catalog[0]["website"], "https://example.com/with-icon");
    assert_eq!(
        catalog[0]["repository"],
        "https://github.com/example/with-icon"
    );
    assert!(catalog[1]["icon"].is_null());
    assert!(catalog[1]["website"].is_null());
    assert!(catalog[1]["repository"].is_null());
}

#[tokio::test]
async fn already_installed_agent_is_reused_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let mut registry = registry();
    let npm = registry.agents[1].distribution.npx.as_mut().unwrap();
    for index in 0..20 {
        npm.env.insert(format!("KEY_{index}"), index.to_string());
    }
    manager.set_registry(registry).unwrap();
    manager
        .install(
            "codex-acp",
            &Threads::new(vec![]),
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    drop(manager);
    for _ in 0..3 {
        let manager = AgentManagement::open(root.path()).unwrap();
        manager
            .install(
                "codex-acp",
                &Threads::new(vec![]),
                &ControlledInstaller { fail: true },
                &|_| {},
            )
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn unsupported_binary_is_disabled_before_download_without_npm_fallback() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let registry = Registry::parse(&serde_json::json!({"version":"1.0.0", "agents":[{"id":"new-agent", "name":"New", "version":"1", "distribution":{"binary":{atte_lib::agent_management::registry::platform():{"archive":"https://fixture/agent.dmg","cmd":"agent"}}, "npx":{"package":"fallback@1"}}}]}).to_string()).unwrap();
    manager.set_registry(registry).unwrap();
    let threads = Threads::new(vec![]);
    assert!(manager.catalog(&threads).unwrap().is_empty());
    assert!(matches!(
        manager
            .install(
                "new-agent",
                &threads,
                &ControlledInstaller { fail: false },
                &|_| {}
            )
            .await,
        Err(ManagementError::Unsupported)
    ));

    let artifact = root.path().join("agents/new-agent/installed");
    std::fs::create_dir_all(&artifact).unwrap();
    let command = artifact.join("agent");
    std::fs::write(&command, "installed").unwrap();
    Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .save_installation(&Installation {
            definition: AgentDefinition {
                id: "new-agent".into(),
                name: "New".into(),
                launch_kind: Default::default(),
                command,
                args: vec![],
                env: Default::default(),
                node_runtime: None,
            },
            version: "1".into(),
            artifact,
        })
        .unwrap();
    let catalog = manager.catalog(&threads).unwrap();
    assert_eq!(catalog.len(), 1);
    assert!(catalog[0].distribution.is_none());
}

struct InterruptedInstaller {
    started: tokio::sync::Notify,
}
impl Installer for InterruptedInstaller {
    fn install<'a>(
        &'a self,
        _: &'a str,
        _: &'a RegistryAgent,
        _: &'a Distribution,
        _: &'a Path,
        _: &'a (dyn Fn(&str) + Send + Sync),
    ) -> InstallFuture<'a> {
        Box::pin(async move {
            self.started.notify_one();
            std::future::pending().await
        })
    }
}

#[tokio::test]
async fn duplicate_install_is_busy_and_aborted_request_can_retry() {
    let root = tempfile::tempdir().unwrap();
    let manager = std::sync::Arc::new(AgentManagement::open(root.path()).unwrap());
    manager.set_registry(registry()).unwrap();
    let installer = std::sync::Arc::new(InterruptedInstaller {
        started: tokio::sync::Notify::new(),
    });
    let task_manager = manager.clone();
    let task_installer = installer.clone();
    let pending = tokio::spawn(async move {
        task_manager
            .install(
                "codex-acp",
                &Threads::new(vec![]),
                task_installer.as_ref(),
                &|_| {},
            )
            .await
    });
    installer.started.notified().await;
    let threads = Threads::new(vec![]);
    assert!(matches!(
        manager
            .install(
                "codex-acp",
                &threads,
                &ControlledInstaller { fail: false },
                &|_| {}
            )
            .await,
        Err(ManagementError::Busy)
    ));
    pending.abort();
    let _ = pending.await;
    assert!(!manager.catalog(&threads).unwrap()[1].installed);
    manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn initially_offline_catalog_is_empty_and_can_be_recovered() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    assert!(manager
        .refresh_from("http://127.0.0.1:1", true)
        .await
        .is_err());
    assert!(manager.catalog(&threads).unwrap().is_empty());
    manager.set_registry(registry()).unwrap();
    assert_eq!(manager.catalog(&threads).unwrap().len(), 3);
}

#[tokio::test]
async fn uninstall_removes_selection_and_files_and_survives_restart() {
    let root = tempfile::tempdir().unwrap();
    let artifact = root.path().join("agents/test-install");
    std::fs::create_dir_all(&artifact).unwrap();
    std::fs::write(artifact.join("agent"), "fixture").unwrap();
    Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .save_installation(&Installation {
            definition: AgentDefinition {
                id: "new-agent".into(),
                name: "New".into(),
                launch_kind: Default::default(),
                command: artifact.join("agent"),
                args: vec![],
                env: Default::default(),
                node_runtime: None,
            },
            version: "1".into(),
            artifact: artifact.clone(),
        })
        .unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    manager.restore(&threads).unwrap();
    manager.uninstall("new-agent", &threads).await.unwrap();
    assert!(threads.prepared_agents().is_empty());
    assert!(!artifact.exists());
    assert!(manager.catalog(&threads).unwrap().is_empty());
    let restored = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    restored.restore(&threads).unwrap();
    assert!(threads.prepared_agents().is_empty());
}

#[tokio::test]
async fn uninstall_removes_files_and_retires_existing_drafts() {
    let root = tempfile::tempdir().unwrap();
    let artifact = root.path().join("agents/in-use");
    std::fs::create_dir_all(&artifact).unwrap();
    std::fs::write(artifact.join("agent"), "fixture").unwrap();
    Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .save_installation(&Installation {
            definition: AgentDefinition {
                id: "new-agent".into(),
                name: "New".into(),
                launch_kind: Default::default(),
                command: artifact.join("agent"),
                args: vec![],
                env: Default::default(),
                node_runtime: None,
            },
            version: "1".into(),
            artifact: artifact.clone(),
        })
        .unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    manager.restore(&threads).unwrap();
    let draft = threads.create_for_agent(root.path(), "new-agent").unwrap();
    manager.uninstall("new-agent", &threads).await.unwrap();
    assert!(!artifact.exists());
    assert!(threads.prepared_agents().is_empty());
    assert!(threads.create_for_agent(root.path(), "new-agent").is_err());
    assert_eq!(
        threads.get(draft.id).unwrap().failure,
        Some(atte_lib::thread::ConnectionFailure::AgentRemoved)
    );
    assert!(threads.connect(draft.id).is_err());
    drop(threads);
    drop(manager);
    AgentManagement::open(root.path()).unwrap();
    assert!(!artifact.exists());
}

#[tokio::test]
async fn uninstall_rejects_external_paths_and_shared_runtime_but_handles_missing_files() {
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let store = Store::open(&root.path().join("atte.sqlite")).unwrap();
    let threads = Threads::new(vec![]);
    let runtime = root.path().join("agents/runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    std::fs::write(runtime.join("keep"), "shared").unwrap();
    for artifact in [external.path().to_path_buf(), runtime.clone()] {
        store
            .save_installation(&Installation {
                definition: AgentDefinition {
                    id: "new-agent".into(),
                    name: "New".into(),
                    launch_kind: Default::default(),
                    command: artifact.join("agent"),
                    args: vec![],
                    env: Default::default(),
                    node_runtime: None,
                },
                version: "1".into(),
                artifact: artifact.clone(),
            })
            .unwrap();
        assert!(manager.uninstall("new-agent", &threads).await.is_err());
        assert!(artifact.exists());
        assert_eq!(store.installations().unwrap().len(), 1);
    }
    let missing = root.path().join("agents/missing");
    let mut installation = store.installations().unwrap().remove(0);
    installation.artifact = missing;
    store.save_installation(&installation).unwrap();
    manager.uninstall("new-agent", &threads).await.unwrap();
    assert!(store.installations().unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(runtime.join("keep")).unwrap(),
        "shared"
    );
}

#[tokio::test]
async fn registry_refresh_preserves_installation_and_uninstall_preserves_catalog_entry() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    manager.set_registry(registry()).unwrap();
    manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    let original = manager
        .catalog(&threads)
        .unwrap()
        .into_iter()
        .find(|a| a.id == "codex-acp")
        .unwrap()
        .artifact;
    let mut newer = registry();
    let codex = newer
        .agents
        .iter_mut()
        .find(|a| a.id == "codex-acp")
        .unwrap();
    codex.version = "999".into();
    codex.name = "New name".into();
    manager.set_registry(newer).unwrap();
    manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: true },
            &|_| {},
        )
        .await
        .unwrap();
    let current = manager
        .catalog(&threads)
        .unwrap()
        .into_iter()
        .find(|a| a.id == "codex-acp")
        .unwrap();
    assert_eq!(current.artifact, original);
    assert_eq!(current.name, "New name");
    manager.uninstall("codex-acp", &threads).await.unwrap();
    let current = manager
        .catalog(&threads)
        .unwrap()
        .into_iter()
        .find(|a| a.id == "codex-acp")
        .unwrap();
    assert!(!current.installed);
    assert!(current.installed_version.is_none());
    assert!(current.distribution.is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn failed_file_removal_keeps_installation_for_retry() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let threads = Threads::new(vec![]);
    manager.set_registry(registry()).unwrap();
    manager
        .install(
            "codex-acp",
            &threads,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    let artifact = manager
        .catalog(&threads)
        .unwrap()
        .into_iter()
        .find(|a| a.id == "codex-acp")
        .unwrap()
        .artifact
        .unwrap();
    std::fs::set_permissions(&artifact, std::fs::Permissions::from_mode(0o500)).unwrap();
    let result = manager.uninstall("codex-acp", &threads).await;
    std::fs::set_permissions(&artifact, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert!(artifact.exists());
    assert_eq!(
        Store::open(&root.path().join("atte.sqlite"))
            .unwrap()
            .installations()
            .unwrap()
            .len(),
        1
    );
    assert!(threads.prepared_agents().is_empty());
    manager.uninstall("codex-acp", &threads).await.unwrap();
    assert!(!artifact.exists());
    assert!(Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .installations()
        .unwrap()
        .is_empty());
}
