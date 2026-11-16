use super::*;
use crate::settings::store::{Legacy, Store};

#[derive(Default)]
struct MemoryCredentials(Mutex<BTreeMap<String, String>>);
impl Credentials for MemoryCredentials {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}
fn service(root: &Path, credentials: Arc<dyn Credentials>) -> Mcp {
    let path = root.join("settings.json");
    let mut store = Store::new(path.clone(), root.join("legacy.json"));
    store.initialize(Legacy::default());
    Mcp::new(
        Arc::new(Mutex::new(store)),
        path,
        credentials,
        std::env::current_exe().unwrap(),
    )
}
fn http() -> Server {
    serde_json::from_value(json!({"type":"http","url":"https://example.com/mcp","headers":{}}))
        .unwrap()
}

#[test]
fn saving_a_secret_does_not_expose_it_and_reopening_preserves_preferences() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("settings.json"),
        r#"{"theme":"dark","locale":"ko","notifications":{"completion":false},"future":42}"#,
    )
    .unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    let service = service(root.path(), credentials.clone());
    let mut server = http();
    server
        .values_mut()
        .insert("Authorization".into(), ValueSource::Secret(String::new()));
    service
        .save(
            &Target::Global,
            "remote",
            server,
            BTreeMap::from([("Authorization".into(), "Bearer test-secret".into())]),
            true,
        )
        .unwrap();
    let bytes = std::fs::read_to_string(root.path().join("settings.json")).unwrap();
    assert!(!bytes.contains("test-secret"));
    let snapshot = serde_json::to_string(&service.snapshot(&Target::Global)).unwrap();
    assert!(!snapshot.contains("test-secret"));
    let document: Value = serde_json::from_str(&bytes).unwrap();
    assert_eq!(
        (
            document["theme"].clone(),
            document["locale"].clone(),
            document["notifications"]["completion"].clone(),
            document["future"].clone()
        ),
        (json!("dark"), json!("ko"), json!(false), json!(42))
    );
    let reopened = super::tests::service(root.path(), credentials);
    let (servers, _) = reopened
        .resolve(root.path(), root.path(), true, &BTreeMap::new())
        .unwrap();
    assert_eq!(
        serde_json::to_value(&servers).unwrap()[0]["headers"][0]["value"],
        "Bearer test-secret"
    );
}

#[test]
fn an_empty_credential_excludes_only_that_server() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    let mut server = http();
    server
        .values_mut()
        .insert("Authorization".into(), ValueSource::Secret(String::new()));
    service
        .save(
            &Target::Global,
            "empty-key",
            server,
            BTreeMap::from([("Authorization".into(), String::new())]),
            true,
        )
        .unwrap();
    service
        .save(&Target::Global, "valid", http(), BTreeMap::new(), true)
        .unwrap();
    let (servers, state) = service
        .resolve(root.path(), root.path(), true, &BTreeMap::new())
        .unwrap();
    assert_eq!(
        serde_json::to_value(&servers)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(state.issues[0].name, "empty-key");
}

#[test]
fn invalid_files_keep_the_last_displayed_servers_and_block_saving_and_sessions() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    let project = Target::Project {
        folder: root.path().into(),
    };
    service
        .save(&project, "remote", http(), BTreeMap::new(), true)
        .unwrap();
    assert!(service.snapshot(&project).servers.contains_key("remote"));
    std::fs::write(root.path().join(".atte/mcp.json"), "{broken").unwrap();
    let snapshot = service.snapshot(&project);
    assert!(snapshot.error.is_some());
    assert!(snapshot.servers.contains_key("remote"));
    assert!(service.toggle(&project, "remote", false).is_err());
    assert!(service
        .resolve(root.path(), root.path(), true, &BTreeMap::new())
        .is_err());
    assert_eq!(
        std::fs::read_to_string(root.path().join(".atte/mcp.json")).unwrap(),
        "{broken"
    );
}

fn fixture() -> PathBuf {
    static EXECUTABLE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    EXECUTABLE
        .get_or_init(|| {
            let output = std::process::Command::new(env!("CARGO"))
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
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find_map(|message| {
                    (message["reason"] == "compiler-artifact"
                        && message["target"]["name"] == "acp-agent-fixture")
                        .then(|| message["executable"].as_str().map(PathBuf::from))
                        .flatten()
                })
                .unwrap()
        })
        .clone()
}
async fn ready(threads: &crate::thread::Threads, id: Uuid) -> crate::thread::Thread {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let current = threads.get(id).unwrap();
            if matches!(
                current.status,
                crate::thread::ThreadStatus::SessionReady | crate::thread::ThreadStatus::Failed
            ) {
                return current;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn acp_new_load_and_resume_forward_servers_and_call_the_stdio_tool() {
    for mode in ["normal", "resume-only"] {
        let root = tempfile::tempdir().unwrap();
        let credentials = Arc::new(MemoryCredentials::default());
        let service = Arc::new(service(root.path(), credentials));
        let executable = fixture();
        let server: Server = serde_json::from_value(json!({"type":"stdio","command":executable,"args":["--mcp"],"env":{"API_KEY":{"kind":"environment","value":"FIXTURE_API_KEY"}}})).unwrap();
        service
            .save(&Target::Global, "tool", server, BTreeMap::new(), true)
            .unwrap();
        let log = root.path().join("mcp-methods.log");
        let agent = crate::agent::AgentDefinition {
            id: "fixture".into(),
            name: "Fixture".into(),
            launch_kind: Default::default(),
            command: executable,
            args: vec![],
            env: std::collections::HashMap::from([
                ("FIXTURE_MODE".into(), mode.into()),
                ("MCP_LOG".into(), log.to_string_lossy().into()),
                ("FIXTURE_API_KEY".into(), "fixture-key".into()),
            ]),
            node_runtime: None,
        };
        let threads = crate::thread::Threads::new(vec![agent]);
        threads.set_mcp(service.clone());
        let draft = threads.create(root.path()).unwrap();
        threads.connect(draft.id).unwrap();
        let connected = ready(&threads, draft.id).await;
        assert_eq!(connected.status, crate::thread::ThreadStatus::SessionReady);
        assert!(
            connected.mcp.issues.is_empty(),
            "{:?}",
            connected.mcp.issues
        );
        threads
            .send_message(draft.id, "Call the MCP tool".into())
            .unwrap();
        let result = ready(&threads, draft.id).await;
        assert!(serde_json::to_string(&result.turns)
            .unwrap()
            .contains("MCP tool result"));
        let other = threads.create(root.path()).unwrap();
        threads.connect(other.id).unwrap();
        let other_connected = ready(&threads, other.id).await;
        service
            .save(
                &Target::Global,
                "unsupported-http",
                http(),
                BTreeMap::new(),
                true,
            )
            .unwrap();
        threads.refresh_mcp();
        assert!(threads.get(draft.id).unwrap().mcp.reconnect_required);
        assert_eq!(
            threads.get(draft.id).unwrap().status,
            crate::thread::ThreadStatus::SessionReady
        );
        threads.reconnect(draft.id).unwrap();
        let restored = ready(&threads, draft.id).await;
        assert!(!restored.mcp.reconnect_required);
        assert_eq!(restored.mcp.issues[0].name, "unsupported-http");
        assert!(restored
            .mcp
            .servers
            .as_ref()
            .unwrap()
            .contains(&"unsupported-http".into()));
        assert!(!threads
            .get(other.id)
            .unwrap()
            .mcp
            .servers
            .as_ref()
            .unwrap()
            .contains(&"unsupported-http".into()));
        assert_eq!(
            threads.get(other.id).unwrap().session_id,
            other_connected.session_id
        );
        assert_eq!(
            threads.get(other.id).unwrap().status,
            crate::thread::ThreadStatus::SessionReady
        );
        threads
            .send_message(draft.id, "Call again after restoration".into())
            .unwrap();
        let called = ready(&threads, draft.id).await;
        assert!(serde_json::to_string(&called.turns.last())
            .unwrap()
            .contains("MCP tool result"));
        let methods = std::fs::read_to_string(&log).unwrap();
        assert!(methods.contains("session/new:tool"));
        assert!(methods.contains(if mode == "resume-only" {
            "session/resume:tool"
        } else {
            "session/load:tool"
        }));
        threads.shutdown().await;
    }
}

#[test]
fn project_overrides_replace_the_whole_server_and_disabled_entries_hide_globals() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let working = root.path().join("worktree");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&working).unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    service
        .save(&Target::Global, "same", http(), BTreeMap::new(), true)
        .unwrap();
    let target = Target::Project {
        folder: project.clone(),
    };
    let server: Server =
        serde_json::from_value(json!({"type":"stdio","command":"./tool","enabled":true})).unwrap();
    std::fs::copy(
        std::env::current_exe().unwrap(),
        working.join(if cfg!(windows) { "tool.exe" } else { "tool" }),
    )
    .unwrap();
    service
        .save(&target, "same", server, BTreeMap::new(), true)
        .unwrap();
    let (servers, _) = service
        .resolve(&project, &working, false, &BTreeMap::new())
        .unwrap();
    let wire = serde_json::to_value(servers).unwrap();
    assert_eq!(
        wire[0]["command"],
        json!(working
            .join(if cfg!(windows) { "tool.exe" } else { "tool" })
            .canonicalize()
            .unwrap())
    );
    assert!(wire[0].get("url").is_none());
    service.toggle(&target, "same", false).unwrap();
    assert!(service
        .resolve(&project, &working, true, &BTreeMap::new())
        .unwrap()
        .0
        .is_empty());
}

#[test]
fn secrets_are_isolated_by_project_and_support_keep_replace_and_delete() {
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    let service = service(root.path(), credentials.clone());
    let project = root.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let target = Target::Project {
        folder: project.clone(),
    };
    let mut server = http();
    server
        .values_mut()
        .insert("Authorization".into(), ValueSource::Secret(String::new()));
    service
        .save(
            &Target::Global,
            "same",
            server.clone(),
            BTreeMap::from([("Authorization".into(), "global-key".into())]),
            true,
        )
        .unwrap();
    service
        .save(
            &target,
            "same",
            server,
            BTreeMap::from([("Authorization".into(), "project-key".into())]),
            true,
        )
        .unwrap();
    let saved = service.snapshot(&target).servers.remove("same").unwrap();
    service
        .save(&target, "same", saved.clone(), BTreeMap::new(), false)
        .unwrap();
    assert_eq!(credentials.0.lock().unwrap().len(), 2);
    service
        .save(
            &target,
            "same",
            saved,
            BTreeMap::from([("Authorization".into(), "new-key".into())]),
            false,
        )
        .unwrap();
    assert_eq!(credentials.0.lock().unwrap().len(), 2);
    let (wire, _) = service
        .resolve(&project, &project, true, &BTreeMap::new())
        .unwrap();
    assert_eq!(
        serde_json::to_value(wire).unwrap()[0]["headers"][0]["value"],
        "new-key"
    );
    service.remove(&target, "same").unwrap();
    let (wire, _) = service
        .resolve(&project, &project, true, &BTreeMap::new())
        .unwrap();
    assert_eq!(
        serde_json::to_value(wire).unwrap()[0]["headers"][0]["value"],
        "global-key"
    );
    assert_eq!(credentials.0.lock().unwrap().len(), 1);
}

struct LockedCredentials;
impl Credentials for LockedCredentials {
    fn get(&self, _: &str) -> Result<Option<String>, String> {
        Err("Credential store locked".into())
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err("Credential store locked".into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err("Credential store locked".into())
    }
}
#[test]
fn credential_store_failure_preserves_the_file_and_never_saves_plaintext() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(LockedCredentials));
    let before = std::fs::read(root.path().join("settings.json")).unwrap();
    let mut server = http();
    server
        .values_mut()
        .insert("Authorization".into(), ValueSource::Secret(String::new()));
    let error = service
        .save(
            &Target::Global,
            "locked",
            server,
            BTreeMap::from([("Authorization".into(), "must-not-leak".into())]),
            true,
        )
        .unwrap_err();
    assert!(!error.contains("must-not-leak"));
    assert_eq!(
        std::fs::read(root.path().join("settings.json")).unwrap(),
        before
    );
}

#[test]
fn unsupported_http_missing_environment_and_bad_executables_do_not_exclude_valid_servers() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    service
        .save(&Target::Global, "http", http(), BTreeMap::new(), true)
        .unwrap();
    for (name, value) in [
        (
            "missing-env",
            json!({"type":"stdio","command":std::env::current_exe().unwrap(),"env":{"API_KEY":{"kind":"environment","value":"MISSING_KEY"}}}),
        ),
        (
            "missing-command",
            json!({"type":"stdio","command":"/missing/command"}),
        ),
        (
            "valid",
            json!({"type":"stdio","command":std::env::current_exe().unwrap(),"args":["argument with spaces", "$(not-a-shell)"]}),
        ),
    ] {
        service
            .save(
                &Target::Global,
                name,
                serde_json::from_value(value).unwrap(),
                BTreeMap::new(),
                true,
            )
            .unwrap();
    }
    let (wire, state) = service
        .resolve(root.path(), root.path(), false, &BTreeMap::new())
        .unwrap();
    assert_eq!(
        serde_json::to_value(wire).unwrap()[0]["args"],
        json!(["argument with spaces", "$(not-a-shell)"])
    );
    assert_eq!(
        state
            .issues
            .iter()
            .map(|issue| issue.name.as_str())
            .collect::<Vec<_>>(),
        ["http", "missing-command", "missing-env"]
    );
}

#[cfg(any(target_os = "macos", windows))]
#[test]
#[ignore = "Writes a temporary credential to the real OS credential store"]
fn native_credentials_round_trip_without_plaintext_storage() {
    let account = format!("atte-test-{}", Uuid::new_v4());
    let native = NativeCredentials;
    native
        .set(&account, "temporary-atte-fixture-secret")
        .unwrap();
    let value = native.get(&account);
    let deleted = native.delete(&account);
    assert_eq!(value.unwrap(), Some("temporary-atte-fixture-secret".into()));
    deleted.unwrap();
    assert!(native.get(&account).unwrap().is_none());
}

#[derive(Default)]
struct DeleteFailure(MemoryCredentials);
impl Credentials for DeleteFailure {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        self.0.get(account)
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.0.set(account, value)
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err("Credential deletion denied".into())
    }
}
#[test]
fn failed_secret_deletion_does_not_commit_the_replacement() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(DeleteFailure::default()));
    let mut server = http();
    server
        .values_mut()
        .insert("Authorization".into(), ValueSource::Secret(String::new()));
    service
        .save(
            &Target::Global,
            "remote",
            server,
            BTreeMap::from([("Authorization".into(), "old-value".into())]),
            true,
        )
        .unwrap();
    let before = std::fs::read(root.path().join("settings.json")).unwrap();
    let server = service
        .snapshot(&Target::Global)
        .servers
        .remove("remote")
        .unwrap();
    assert!(service
        .save(
            &Target::Global,
            "remote",
            server,
            BTreeMap::from([("Authorization".into(), "replacement".into())]),
            false
        )
        .is_err());
    assert_eq!(
        std::fs::read(root.path().join("settings.json")).unwrap(),
        before
    );
}

#[tokio::test]
async fn managed_worktrees_read_source_settings_and_run_tools_in_the_working_folder() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    std::fs::create_dir(&source).unwrap();
    for args in [
        vec!["init"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    ] {
        assert!(std::process::Command::new("git")
            .current_dir(&source)
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    }
    let service = Arc::new(service(root.path(), Arc::new(MemoryCredentials::default())));
    service
        .save(&Target::Global, "tool", http(), BTreeMap::new(), true)
        .unwrap();
    let executable = fixture();
    let server: Server = serde_json::from_value(json!({"type":"stdio","command":executable,"args":["--mcp"],"env":{"API_KEY":{"kind":"literal","value":"fixture-key"}}})).unwrap();
    service
        .save(
            &Target::Project {
                folder: source.clone(),
            },
            "tool",
            server,
            BTreeMap::new(),
            true,
        )
        .unwrap();
    let agent = crate::agent::AgentDefinition {
        id: "fixture".into(),
        name: "Fixture".into(),
        launch_kind: Default::default(),
        command: executable,
        args: vec![],
        env: std::collections::HashMap::from([(
            "MCP_LOG".into(),
            root.path().join("calls.log").to_string_lossy().into(),
        )]),
        node_runtime: None,
    };
    let threads = crate::thread::Threads::new(vec![agent]);
    threads.set_mcp(service);
    let draft = threads
        .create_in_worktree(&source, &root.path().join("worktrees"), "fixture")
        .await
        .unwrap();
    threads.connect(draft.id).unwrap();
    let connected = ready(&threads, draft.id).await;
    assert!(
        connected.mcp.issues.is_empty(),
        "{:?}",
        connected.mcp.issues
    );
    threads.send_message(draft.id, "Call tool".into()).unwrap();
    let called = ready(&threads, draft.id).await;
    let expected = serde_json::to_string(&format!(
        "MCP tool result: {}",
        draft.working_folder.display()
    ))
    .unwrap();
    assert!(serde_json::to_string(&called.turns)
        .unwrap()
        .contains(&expected));
    threads.shutdown().await;
}

struct EditingCredentials {
    values: MemoryCredentials,
    path: PathBuf,
}
impl Credentials for EditingCredentials {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        self.values.get(account)
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        let mut document: Value =
            serde_json::from_slice(&std::fs::read(&self.path).unwrap()).unwrap();
        document["mcpServers"]["remote"] =
            json!({"type":"http","url":"https://edited.example/mcp"});
        std::fs::write(&self.path, serde_json::to_vec(&document).unwrap()).unwrap();
        self.values.set(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.values.delete(account)
    }
}
#[test]
fn edits_during_credential_storage_are_not_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let service = service(
        root.path(),
        Arc::new(EditingCredentials {
            values: MemoryCredentials::default(),
            path: root.path().join("settings.json"),
        }),
    );
    service
        .save(&Target::Global, "remote", http(), BTreeMap::new(), true)
        .unwrap();
    let mut server = http();
    server
        .values_mut()
        .insert("Authorization".into(), ValueSource::Secret(String::new()));
    assert!(service
        .save(
            &Target::Global,
            "remote",
            server,
            BTreeMap::from([("Authorization".into(), "secret".into())]),
            false
        )
        .is_err());
    let saved = service.snapshot(&Target::Global);
    assert_eq!(
        serde_json::to_value(&saved.servers["remote"]).unwrap()["url"],
        "https://edited.example/mcp"
    );
}

#[tokio::test]
async fn agents_cannot_echo_mcp_credentials_into_connection_errors() {
    let root = tempfile::tempdir().unwrap();
    let service = Arc::new(service(root.path(), Arc::new(MemoryCredentials::default())));
    let executable = fixture();
    let mut server: Server =
        serde_json::from_value(json!({"type":"stdio","command":executable})).unwrap();
    server
        .values_mut()
        .insert("API_KEY".into(), ValueSource::Secret(String::new()));
    service
        .save(
            &Target::Global,
            "tool",
            server,
            BTreeMap::from([("API_KEY".into(), "private-fixture-token".into())]),
            true,
        )
        .unwrap();
    let agent = crate::agent::AgentDefinition {
        id: "fixture".into(),
        name: "Fixture".into(),
        launch_kind: Default::default(),
        command: executable,
        args: vec![],
        env: std::collections::HashMap::from([
            ("FIXTURE_MODE".into(), "session-error".into()),
            ("MCP_REJECT".into(), "1".into()),
        ]),
        node_runtime: None,
    };
    let threads = crate::thread::Threads::new(vec![agent]);
    threads.set_mcp(service);
    let draft = threads.create(root.path()).unwrap();
    threads.connect(draft.id).unwrap();
    let failed = ready(&threads, draft.id).await;
    assert_eq!(failed.status, crate::thread::ThreadStatus::Failed);
    assert!(!serde_json::to_string(&failed)
        .unwrap()
        .contains("private-fixture-token"));
    threads.shutdown().await;
}

#[test]
fn renaming_a_value_preserves_its_saved_secret_reference() {
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    let service = service(root.path(), credentials.clone());
    let mut server = http();
    server
        .values_mut()
        .insert("Authorization".into(), ValueSource::Secret(String::new()));
    service
        .save(
            &Target::Global,
            "remote",
            server,
            BTreeMap::from([("Authorization".into(), "keep-this-key".into())]),
            true,
        )
        .unwrap();
    let mut server = service
        .snapshot(&Target::Global)
        .servers
        .remove("remote")
        .unwrap();
    let source = server.values_mut().remove("Authorization").unwrap();
    server.values_mut().insert("X-Api-Key".into(), source);
    service
        .save(&Target::Global, "remote", server, BTreeMap::new(), false)
        .unwrap();
    assert_eq!(credentials.0.lock().unwrap().len(), 1);
    let (wire, _) = service
        .resolve(root.path(), root.path(), true, &BTreeMap::new())
        .unwrap();
    assert_eq!(
        serde_json::to_value(wire).unwrap()[0]["headers"][0],
        json!({"name":"X-Api-Key","value":"keep-this-key"})
    );
}

mod http_session;

mod check;
mod check_http;
mod import;

mod oauth;

#[test]
fn session_inventory_includes_enabled_servers_and_keeps_failures_separate() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    for (name, enabled) in [("enabled", true), ("disabled", false)] {
        let mut server = http();
        server.enabled = enabled;
        service
            .save(&Target::Global, name, server, BTreeMap::new(), true)
            .unwrap();
    }
    let (servers, state) = service
        .resolve(root.path(), root.path(), true, &BTreeMap::new())
        .unwrap();
    assert_eq!(servers.len(), 1);
    assert_eq!(state.servers, Some(vec!["enabled".into()]));
    assert!(state.issues.is_empty());
    let (servers, state) = service
        .resolve(root.path(), root.path(), false, &BTreeMap::new())
        .unwrap();
    assert!(servers.is_empty());
    assert_eq!(state.servers, Some(vec!["enabled".into()]));
    assert_eq!(state.issues[0].name, "enabled");
    service.toggle(&Target::Global, "enabled", false).unwrap();
    let (_, state) = service
        .resolve(root.path(), root.path(), true, &BTreeMap::new())
        .unwrap();
    assert_eq!(state.servers, Some(vec![]));
    assert_eq!(SessionState::default().servers, None);
}
