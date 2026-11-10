//! Opt-in Registry compatibility sweep. Run with an isolated HOME and app-data root.
use super::{
    installer::SystemInstaller,
    registry::{self, RegistryAgent},
    AgentManagement,
};
use crate::{
    agent::AgentDefinition,
    storage::Store,
    thread::{ThreadStatus, Threads},
};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

async fn diagnostic(agent: &AgentDefinition, folder: &Path) -> Value {
    let launch = match super::launch::resolve(agent).await {
        Ok(launch) => launch,
        Err(error) => return json!({"resolve_error":error.to_string()}),
    };
    let mut command = tokio::process::Command::new(launch.program);
    command
        .args(launch.args)
        .envs(&agent.env)
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = launch.path {
        command.env("PATH", path);
    }
    let (mut child, mut group) = match crate::agent_runtime::spawn_process(&mut command) {
        Ok(process) => process,
        Err(error) => return json!({"spawn_error":error.to_string()}),
    };
    let stderr = child.stderr.take().unwrap();
    let errors = tokio::spawn(async move {
        let mut reader = stderr;
        let mut tail = Vec::new();
        let mut buffer = [0; 2048];
        while let Ok(count) = reader.read(&mut buffer).await {
            if count == 0 {
                break;
            }
            tail.extend_from_slice(&buffer[..count]);
            if tail.len() > 8192 {
                tail.drain(..tail.len() - 8192);
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut input = child.stdin.take().unwrap();
    let request = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"atte-compatibility-test","version":"0.1.0"}}});
    let _ = input.write_all(format!("{request}\n").as_bytes()).await;
    let response = tokio::time::timeout(Duration::from_secs(20), async {
        let mut noise = Vec::new();
        while let Ok(Some(line)) = stdout.next_line().await {
            match serde_json::from_str::<Value>(&line) {
                Ok(value) if value["id"] == 1 => {
                    return json!({
                        "initialize_result":value.get("result").is_some(),
                        "error":value.get("error"), "stdout_noise":noise,
                    })
                }
                Ok(_) => {}
                Err(_) if noise.len() < 3 => noise.push(line.chars().take(300).collect::<String>()),
                Err(_) => {}
            }
        }
        json!({"stdout_closed":true,"stdout_noise":noise})
    })
    .await
    .unwrap_or(json!({"initialize_timeout":true}));
    let exit = child
        .try_wait()
        .ok()
        .flatten()
        .map(|status| status.to_string());
    drop(input);
    let _ = tokio::task::spawn_blocking(move || group.kill()).await;
    let _ = child.kill().await;
    let _ = child.wait().await;
    let stderr = tokio::time::timeout(Duration::from_secs(2), errors)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    json!({"response":response,"exit":exit,"stderr_tail":stderr})
}

async fn run_agent(
    manager: &AgentManagement,
    threads: &Threads,
    installer: &SystemInstaller,
    entry: RegistryAgent,
    root: &Path,
) -> Value {
    let start = Instant::now();
    let id = &entry.id;
    let kind = if entry
        .distribution
        .binary
        .contains_key(&registry::platform())
    {
        "binary"
    } else {
        "npm"
    };
    let mut result =
        json!({"id":id,"name":entry.name,"registry_version":entry.version,"distribution":kind});
    println!("START {id} ({kind})");
    let progress = Mutex::new(String::new());
    let install = tokio::time::timeout(
        Duration::from_secs(360),
        manager.install(id, threads, installer, &|message| {
            *progress.lock().unwrap() = message.to_owned()
        }),
    )
    .await;
    match install {
        Ok(Ok(())) => {
            result["install"] = json!("ok");
        }
        other => {
            result["install"] = json!("failed");
            result["error"] = json!(match other {
                Ok(Err(error)) => error.to_string(),
                _ => "installation timeout".into(),
            });
            result["last_progress"] = json!(*progress.lock().unwrap());
            result["seconds"] = json!(start.elapsed().as_secs());
            return result;
        }
    }
    let auth = manager.authenticate(id, None, threads).await;
    match auth {
        Ok(auth) => {
            result["initialize"] = json!("ok");
            result["auth_methods"] = json!(auth
                .methods
                .iter()
                .map(|method| &method.name)
                .collect::<Vec<_>>());
        }
        Err(error) => {
            result["initialize"] = json!("failed");
            result["initialize_error"] = json!(error.to_string());
        }
    }
    let folder = root.join("workspaces").join(id);
    std::fs::create_dir_all(&folder).unwrap();
    match threads
        .create_for_agent(&folder, id)
        .and_then(|thread| threads.connect(thread.id))
    {
        Ok(thread) => {
            let state = tokio::time::timeout(Duration::from_secs(45), async {
                loop {
                    let state = threads.get(thread.id).unwrap();
                    if matches!(
                        state.status,
                        ThreadStatus::SessionReady
                            | ThreadStatus::Failed
                            | ThreadStatus::WaitingForInput
                    ) {
                        return state;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await;
            match state {
                Ok(state) => {
                    result["session"] = json!(if state.status == ThreadStatus::SessionReady {
                        "ok"
                    } else {
                        "failed"
                    });
                    result["failure"] = json!(state.failure);
                    result["authentication"] = json!(state.authentication);
                    result["session_error"] = json!(state
                        .failure_detail
                        .map(|error| json!({"code":error.code,"message":error.message})));
                }
                Err(_) => result["session"] = json!("timeout"),
            }
            let _ = threads.delete(thread.id).await;
        }
        Err(error) => {
            result["session"] = json!("failed");
            result["session_error"] = json!(error.to_string());
        }
    }
    let installation = Store::open(&root.join("atte.sqlite"))
        .unwrap()
        .installations()
        .unwrap()
        .into_iter()
        .find(|installation| installation.definition.id == *id)
        .unwrap();
    result["installed_version"] = json!(installation.version);
    result["launch_kind"] = json!(installation.definition.launch_kind);
    if result["initialize"] != "ok"
        || (result["session"] != "ok" && result["failure"] != "authenticationRequired")
    {
        let mut definition = installation.definition;
        definition.node_runtime = Some(manager.runtime.clone());
        result["diagnostic"] = diagnostic(&definition, &folder).await;
    }
    result["seconds"] = json!(start.elapsed().as_secs());
    result
}

#[tokio::test]
#[ignore = "downloads and executes Registry agents; requires isolated HOME and ATTE_SWEEP_ROOT/REPORT"]
async fn installed_registry_agents_initialize_and_create_sessions() {
    let root = PathBuf::from(std::env::var_os("ATTE_SWEEP_ROOT").expect("isolated app root"));
    let report = PathBuf::from(std::env::var_os("ATTE_SWEEP_REPORT").expect("report path"));
    let home = PathBuf::from(std::env::var_os("HOME").expect("isolated HOME"));
    assert_eq!(
        home.parent(),
        root.parent(),
        "HOME and app root must be siblings in an isolated directory"
    );
    std::fs::create_dir_all(&root).unwrap();
    let body = if let Some(snapshot) = std::env::var_os("ATTE_SWEEP_REGISTRY") {
        std::fs::read_to_string(snapshot).unwrap()
    } else {
        reqwest::get(registry::REGISTRY_URL)
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .await
            .unwrap()
    };
    std::fs::write(root.join("registry.json"), &body).unwrap();
    let registry = registry::Registry::parse(&body).unwrap();
    let excluded = ["claude-acp", "codex-acp", "grok-build", "antigravity-acp"];
    let filter = std::env::var("ATTE_SWEEP_ONLY").ok();
    let targets: Vec<_> = registry
        .agents
        .iter()
        .filter(|entry| {
            !excluded.contains(&entry.id.as_str())
                && entry.distribution(&registry::platform()).is_some()
                && filter
                    .as_ref()
                    .is_none_or(|ids| ids.split(',').any(|id| id == entry.id))
        })
        .cloned()
        .collect();
    let skipped: Vec<_> = registry.agents.iter().filter(|entry| !excluded.contains(&entry.id.as_str()) && entry.distribution(&registry::platform()).is_none())
        .map(|entry| json!({"id":entry.id,"name":entry.name,"reason":entry.unsupported_reason(&registry::platform())})).collect();
    println!(
        "PLATFORM {} TARGETS {} SKIPPED {}",
        registry::platform(),
        targets.len(),
        skipped.len()
    );
    let manager = AgentManagement::open(&root).unwrap();
    manager.set_registry(registry).unwrap();
    // Rechecks can reuse immutable artifacts without opening or repairing the
    // running sweep's app-data directory.
    if let Some(source) = std::env::var_os("ATTE_SWEEP_REUSE_STORE") {
        let source = rusqlite::Connection::open_with_flags(
            source,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let destination = Store::open(&root.join("atte.sqlite")).unwrap();
        for entry in &targets {
            let stored: Result<(String, String, String), _> = source.query_row(
                "SELECT installed_version, artifact_path, launch_definition FROM agents WHERE id=?1 AND artifact_path IS NOT NULL",
                [&entry.id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            );
            if let Ok((version, artifact, definition)) = stored {
                destination
                    .save_installation(&crate::storage::Installation {
                        version,
                        artifact: artifact.into(),
                        definition: serde_json::from_str(&definition).unwrap(),
                    })
                    .unwrap();
            }
        }
    }
    let threads = manager.restore_threads().unwrap();
    let installer = SystemInstaller::default();
    let rows = Arc::new(Mutex::new(Vec::<Value>::new()));
    stream::iter(targets)
        .for_each_concurrent(3, |entry| {
            let manager = &manager;
            let threads = &threads;
            let installer = &installer;
            let root = &root;
            let report = &report;
            let rows = &rows;
            let skipped = &skipped;
            async move {
                let result = run_agent(manager, threads, installer, entry, root).await;
                println!(
                    "DONE {} install={} initialize={} session={} seconds={}",
                    result["id"],
                    result["install"],
                    result["initialize"],
                    result["session"],
                    result["seconds"]
                );
                let mut rows = rows.lock().unwrap();
                rows.push(result);
                rows.sort_by_key(|row| row["id"].as_str().unwrap_or_default().to_owned());
                std::fs::write(
                    report,
                    serde_json::to_vec_pretty(
                        &json!({"platform":registry::platform(),"results":*rows,"skipped":skipped}),
                    )
                    .unwrap(),
                )
                .unwrap();
            }
        })
        .await;
    threads.shutdown().await;
}
