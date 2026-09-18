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
            command: "/installed/node".into(),
            args: vec!["/installed/adapter.js".into()],
            env: Default::default(),
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
fn migrates_an_empty_database_and_reopens_schema_one() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("atte.sqlite");
    rusqlite::Connection::open(&path).unwrap();
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
    conversation::Conversations,
};
use std::path::Path;

struct ControlledInstaller {
    fail: bool,
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
            let artifact = root.join(id);
            std::fs::create_dir_all(&artifact).unwrap();
            std::fs::write(artifact.join("fixture"), "installation").unwrap();
            Ok(Installation {
                definition: AgentDefinition {
                    id: id.into(),
                    name: entry.name.clone(),
                    command: std::env::current_exe().unwrap(),
                    args: vec![],
                    env: Default::default(),
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
    let conversations = Conversations::new(vec![]);
    assert!(management
        .install(
            "codex-acp",
            &conversations,
            &ControlledInstaller { fail: true },
            &|_| {}
        )
        .await
        .is_err());
    assert!(
        !management
            .catalog(&conversations)
            .unwrap()
            .iter()
            .find(|agent| agent.id == "codex-acp")
            .unwrap()
            .installed
    );
    assert!(conversations.prepared_agents().is_empty());
    management
        .install(
            "codex-acp",
            &conversations,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    assert_eq!(conversations.prepared_agents()[0].id, "codex-acp");
    drop(management);
    let restored = AgentManagement::open(root.path()).unwrap();
    let conversations = Conversations::new(vec![]);
    restored.restore(&conversations).unwrap();
    assert_eq!(conversations.prepared_agents()[0].id, "codex-acp");
    let catalog = restored.catalog(&conversations).unwrap();
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
fn opens_the_oldest_committed_schema_fixture() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("atte.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(include_str!("fixtures/schema-v1.sql"))
        .unwrap();
    let installations = Store::open(&path).unwrap().installations().unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 4);
    let tables: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(tables, ["agents", "app_metadata", "conversations"]);
    assert_eq!(installations[0].definition.id, "codex-acp");
    assert_eq!(installations[0].version, "1.12.0");
}

#[tokio::test]
async fn unknown_registry_agent_survives_offline_restart_and_registry_removal() {
    let root = tempfile::tempdir().unwrap();
    let management = AgentManagement::open(root.path()).unwrap();
    let conversations = Conversations::new(vec![]);
    let mut registry = registry();
    let mut added = registry.agents[0].clone();
    added.id = "new-provider".into();
    added.name = "New provider".into();
    registry.agents.push(added);
    management.set_registry(registry).unwrap();
    assert_eq!(management.catalog(&conversations).unwrap().len(), 4);
    management
        .install(
            "new-provider",
            &conversations,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    drop(management);
    let management = AgentManagement::open(root.path()).unwrap();
    assert_eq!(management.catalog(&conversations).unwrap().len(), 4);
    management
        .set_registry(Registry::parse(r#"{"version":"1.0.0","agents":[]}"#).unwrap())
        .unwrap();
    let catalog = management.catalog(&conversations).unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].id, "new-provider");
    assert!(catalog[0].installed);
    assert!(catalog[0].distribution.is_none());
}

#[tokio::test]
async fn cached_catalog_survives_failed_refresh_and_reuses_a_good_installation() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let conversations = Conversations::new(vec![]);
    manager.set_registry(registry()).unwrap();
    manager
        .install(
            "codex-acp",
            &conversations,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    assert!(manager
        .refresh_from("http://127.0.0.1:1", true)
        .await
        .is_err());
    assert_eq!(manager.catalog(&conversations).unwrap().len(), 3);
    manager
        .install(
            "codex-acp",
            &conversations,
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

#[test]
fn catalog_preserves_optional_registry_icons_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let registry = serde_json::from_value(serde_json::json!({
        "version": "1.0.0",
        "agents": [
            {"id": "with-icon", "name": "With icon", "version": "1", "distribution": {},
             "icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/example.svg"},
            {"id": "without-icon", "name": "Without icon", "version": "1", "distribution": {}}
        ]
    }))
    .unwrap();
    manager.set_registry(registry).unwrap();
    drop(manager);
    let manager = AgentManagement::open(root.path()).unwrap();
    let catalog =
        serde_json::to_value(manager.catalog(&Conversations::new(vec![])).unwrap()).unwrap();
    assert_eq!(
        catalog[0]["icon"],
        "https://cdn.agentclientprotocol.com/registry/v1/latest/example.svg"
    );
    assert!(catalog[1]["icon"].is_null());
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
            &Conversations::new(vec![]),
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
                &Conversations::new(vec![]),
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
    let conversations = Conversations::new(vec![]);
    let catalog = manager.catalog(&conversations).unwrap();
    assert!(catalog[0].distribution.is_none());
    assert!(catalog[0].unavailable_reason.is_some());
    assert!(matches!(
        manager
            .install(
                "new-agent",
                &conversations,
                &ControlledInstaller { fail: false },
                &|_| {}
            )
            .await,
        Err(ManagementError::Unsupported)
    ));
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
                &Conversations::new(vec![]),
                task_installer.as_ref(),
                &|_| {},
            )
            .await
    });
    installer.started.notified().await;
    let conversations = Conversations::new(vec![]);
    assert!(matches!(
        manager
            .install(
                "codex-acp",
                &conversations,
                &ControlledInstaller { fail: false },
                &|_| {}
            )
            .await,
        Err(ManagementError::Busy)
    ));
    pending.abort();
    let _ = pending.await;
    assert!(!manager.catalog(&conversations).unwrap()[1].installed);
    manager
        .install(
            "codex-acp",
            &conversations,
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
    let conversations = Conversations::new(vec![]);
    assert!(manager
        .refresh_from("http://127.0.0.1:1", true)
        .await
        .is_err());
    assert!(manager.catalog(&conversations).unwrap().is_empty());
    manager.set_registry(registry()).unwrap();
    assert_eq!(manager.catalog(&conversations).unwrap().len(), 3);
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
                command: artifact.join("agent"),
                args: vec![],
                env: Default::default(),
            },
            version: "1".into(),
            artifact: artifact.clone(),
        })
        .unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let conversations = Conversations::new(vec![]);
    manager.restore(&conversations).unwrap();
    manager
        .uninstall("new-agent", &conversations)
        .await
        .unwrap();
    assert!(conversations.prepared_agents().is_empty());
    assert!(!artifact.exists());
    assert!(manager.catalog(&conversations).unwrap().is_empty());
    let restored = AgentManagement::open(root.path()).unwrap();
    let conversations = Conversations::new(vec![]);
    restored.restore(&conversations).unwrap();
    assert!(conversations.prepared_agents().is_empty());
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
                command: artifact.join("agent"),
                args: vec![],
                env: Default::default(),
            },
            version: "1".into(),
            artifact: artifact.clone(),
        })
        .unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let conversations = Conversations::new(vec![]);
    manager.restore(&conversations).unwrap();
    let draft = conversations
        .create_for_agent(root.path(), "new-agent")
        .unwrap();
    manager
        .uninstall("new-agent", &conversations)
        .await
        .unwrap();
    assert!(!artifact.exists());
    assert!(conversations.prepared_agents().is_empty());
    assert!(conversations
        .create_for_agent(root.path(), "new-agent")
        .is_err());
    assert_eq!(
        conversations.get(draft.id).unwrap().failure,
        Some(atte_lib::conversation::ConnectionFailure::AgentRemoved)
    );
    assert!(conversations.connect(draft.id).is_err());
    drop(conversations);
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
    let conversations = Conversations::new(vec![]);
    let runtime = root.path().join("agents/runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    std::fs::write(runtime.join("keep"), "shared").unwrap();
    for artifact in [external.path().to_path_buf(), runtime.clone()] {
        store
            .save_installation(&Installation {
                definition: AgentDefinition {
                    id: "new-agent".into(),
                    name: "New".into(),
                    command: artifact.join("agent"),
                    args: vec![],
                    env: Default::default(),
                },
                version: "1".into(),
                artifact: artifact.clone(),
            })
            .unwrap();
        assert!(manager
            .uninstall("new-agent", &conversations)
            .await
            .is_err());
        assert!(artifact.exists());
        assert_eq!(store.installations().unwrap().len(), 1);
    }
    let missing = root.path().join("agents/missing");
    let mut installation = store.installations().unwrap().remove(0);
    installation.artifact = missing;
    store.save_installation(&installation).unwrap();
    manager
        .uninstall("new-agent", &conversations)
        .await
        .unwrap();
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
    let conversations = Conversations::new(vec![]);
    manager.set_registry(registry()).unwrap();
    manager
        .install(
            "codex-acp",
            &conversations,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    let original = manager
        .catalog(&conversations)
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
            &conversations,
            &ControlledInstaller { fail: true },
            &|_| {},
        )
        .await
        .unwrap();
    let current = manager
        .catalog(&conversations)
        .unwrap()
        .into_iter()
        .find(|a| a.id == "codex-acp")
        .unwrap();
    assert_eq!(current.artifact, original);
    assert_eq!(current.name, "New name");
    manager
        .uninstall("codex-acp", &conversations)
        .await
        .unwrap();
    let current = manager
        .catalog(&conversations)
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
    let conversations = Conversations::new(vec![]);
    manager.set_registry(registry()).unwrap();
    manager
        .install(
            "codex-acp",
            &conversations,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    let artifact = manager
        .catalog(&conversations)
        .unwrap()
        .into_iter()
        .find(|a| a.id == "codex-acp")
        .unwrap()
        .artifact
        .unwrap();
    std::fs::set_permissions(&artifact, std::fs::Permissions::from_mode(0o500)).unwrap();
    let result = manager.uninstall("codex-acp", &conversations).await;
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
    assert!(conversations.prepared_agents().is_empty());
    manager
        .uninstall("codex-acp", &conversations)
        .await
        .unwrap();
    assert!(!artifact.exists());
    assert!(Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .installations()
        .unwrap()
        .is_empty());
}
