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
            id: "codex".into(),
            name: "Codex".into(),
            command: "/installed/node".into(),
            args: vec!["/installed/adapter.js".into()],
            env: Default::default(),
        },
        version: "1.12.0".into(),
        artifact: root.path().join("codex"),
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
            std::fs::create_dir_all(root).unwrap();
            Ok(Installation {
                definition: AgentDefinition {
                    id: id.into(),
                    name: entry.name.clone(),
                    command: std::env::current_exe().unwrap(),
                    args: vec![],
                    env: Default::default(),
                },
                version: entry.version.clone(),
                artifact: root.into(),
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
            "codex",
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
            .find(|agent| agent.id == "codex")
            .unwrap()
            .installed
    );
    assert!(conversations.prepared_agents().is_empty());
    management
        .install(
            "codex",
            &conversations,
            &ControlledInstaller { fail: false },
            &|_| {},
        )
        .await
        .unwrap();
    assert_eq!(conversations.prepared_agents()[0].id, "codex");
    drop(management);
    let restored = AgentManagement::open(root.path()).unwrap();
    let conversations = Conversations::new(vec![]);
    restored.restore(&conversations).unwrap();
    assert_eq!(conversations.prepared_agents()[0].id, "codex");
    let catalog = restored.catalog(&conversations).unwrap();
    let codex = catalog.iter().find(|agent| agent.id == "codex").unwrap();
    assert!(codex.installed);
    assert!(!codex.authentication.authenticated);
}

#[test]
fn registry_selects_platform_binary_or_npm_and_excludes_other_agents() {
    let registry = registry();
    assert!(matches!(
        registry
            .target("codex")
            .unwrap()
            .distribution("darwin-aarch64"),
        Some(Distribution::Npm(_))
    ));
    assert!(matches!(
        registry
            .target("antigravity")
            .unwrap()
            .distribution("darwin-aarch64"),
        Some(Distribution::Binary(_))
    ));
    assert!(registry
        .target("antigravity")
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
    assert_eq!(installations[0].definition.id, "codex");
    assert_eq!(installations[0].version, "1.12.0");
}
