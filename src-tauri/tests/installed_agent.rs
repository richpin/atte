//! Opt-in smoke check against an existing installation; the source app DB is read-only.
use atte_lib::{
    agent::AgentDefinition,
    agent_management::AgentManagement,
    storage::{Installation, Store},
    thread::{ThreadStatus, Threads},
};
use std::{path::PathBuf, time::Duration};

async fn ready(threads: &Threads, id: uuid::Uuid) {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let state = threads.get(id).unwrap();
            if state.status == ThreadStatus::SessionReady {
                return;
            }
            assert_ne!(
                state.status,
                ThreadStatus::Failed,
                "connection failure: {:?}",
                state.failure
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("installed agent did not become ready");
}

#[tokio::test]
#[ignore = "requires ATTE_INSTALLED_AGENT_STORE and an installed/authenticated agent"]
async fn installed_agent_restores_connects_and_reconnects() {
    let source =
        PathBuf::from(std::env::var_os("ATTE_INSTALLED_AGENT_STORE").expect("source DB path"));
    let id = std::env::var("ATTE_INSTALLED_AGENT_ID").unwrap_or_else(|_| "grok-build".into());
    let connection =
        rusqlite::Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let (version, artifact, launch): (String, String, String) = connection
        .query_row(
            "SELECT installed_version, artifact_path, launch_definition FROM agents WHERE id=?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    drop(connection);
    let definition: AgentDefinition = serde_json::from_str(&launch).unwrap();
    let artifact = PathBuf::from(artifact);
    let manifest = std::fs::read(artifact.join("installation.json")).unwrap();
    let root = tempfile::tempdir().unwrap();
    Store::open(&root.path().join("atte.sqlite"))
        .unwrap()
        .save_installation(&Installation {
            definition,
            version,
            artifact: artifact.clone(),
        })
        .unwrap();
    let manager = AgentManagement::open(root.path()).unwrap();
    let threads = manager.restore_threads().unwrap();
    let thread = threads.create_for_agent(root.path(), &id).unwrap();
    threads.connect(thread.id).unwrap();
    ready(&threads, thread.id).await;
    println!("installed agent: session ready");
    threads.reconnect(thread.id).unwrap();
    ready(&threads, thread.id).await;
    println!("installed agent: reconnect ready");
    if std::env::var_os("ATTE_LIVE_PROMPT").is_some() {
        threads
            .send_message(
                thread.id,
                "Reply with exactly ATTE_ACP_OK. Do not use tools or modify any files.".into(),
            )
            .unwrap();
        ready(&threads, thread.id).await;
        let state = threads.get(thread.id).unwrap();
        let response = state.turns.last().unwrap().response_text();
        assert!(
            response.contains("ATTE_ACP_OK"),
            "expected smoke response was not received"
        );
        println!("installed agent: prompt round trip passed");
    }
    threads.shutdown().await;
    assert_eq!(
        std::fs::read(artifact.join("installation.json")).unwrap(),
        manifest
    );
}
