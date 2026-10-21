//! Seeds a separate desktop profile with a real stdio ACP content test agent.
use atte_lib::{
    agent::AgentDefinition,
    storage::{Installation, Store},
    thread::Threads,
};
use std::{env, fs, path::PathBuf, sync::Arc};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let root = PathBuf::from(args.next().ok_or("missing isolated app data directory")?);
    let fixture = PathBuf::from(args.next().ok_or("missing ACP fixture executable")?);
    if args.next().is_some() {
        return Err("expected app data directory and fixture executable".into());
    }
    fs::create_dir_all(&root)?;
    let root = root.canonicalize()?;
    let artifact = root
        .join("agents/acp-content-demo")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&artifact)?;
    let executable = artifact.join("acp-agent-fixture");
    fs::copy(fixture, &executable)?;
    let agent = AgentDefinition {
        id: "acp-content-demo".into(),
        name: "ACP Content Test".into(),
        launch_kind: Default::default(),
        command: executable,
        args: vec![],
        env: [
            ("FIXTURE_MODE".into(), "content-demo".into()),
            (
                "SESSION_FILE".into(),
                root.join("content-history.json")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ]
        .into(),
        node_runtime: None,
    };
    let store = Arc::new(Store::open(&root.join("atte.sqlite"))?);
    store.save_installation(&Installation {
        definition: agent.clone(),
        version: "0.0.0".into(),
        artifact,
    })?;
    let threads = Threads::with_store(vec![agent], store)?;
    if threads.list()?.is_empty() {
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace)?;
        let draft = threads.create(&workspace)?;
        threads.rename(draft.id, "ACP 콘텐츠 확인 — 여기에 메시지를 보내세요")?;
    }
    println!("테스트 데이터: {}", root.display());
    println!("테스트 앱에서 ‘ACP 콘텐츠 확인’ 대화를 열고 아무 메시지나 보내세요.");
    Ok(())
}
