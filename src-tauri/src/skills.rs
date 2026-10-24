//! Installed skill management through the pinned `skills` CLI.
use crate::{agent_management::node_runtime::NodeRuntime, agent_runtime::ProcessGroup};
use gray_matter::{engine::YAML, Matter};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tauri::State;
use tokio::{process::Command, sync::Mutex};

const VERSION: &str = "1.7.4";
const LIST_TIMEOUT: Duration = Duration::from_secs(60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_DOCUMENT_BYTES: u64 = 1_048_576;

#[derive(Clone, Deserialize)]
#[serde(tag = "scope", rename_all = "camelCase")]
pub enum SkillTarget {
    Global,
    Project { folder: PathBuf },
}

impl SkillTarget {
    fn working_directory<'a>(&'a self, root: &'a Path) -> Result<&'a Path, String> {
        match self {
            Self::Global => Ok(root),
            Self::Project { folder } if folder.is_absolute() && folder.is_dir() => Ok(folder),
            Self::Project { .. } => Err("유효한 프로젝트 작업 폴더를 선택해주세요.".into()),
        }
    }

    fn is_global(&self) -> bool {
        matches!(self, Self::Global)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub name: String,
    pub path: PathBuf,
    pub scope: String,
    pub agents: Vec<String>,
    pub source: Option<String>,
    pub source_url: Option<String>,
    pub source_type: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDocument {
    pub description: Option<String>,
    pub markdown: String,
}

#[derive(Deserialize)]
struct SkillFrontMatter {
    description: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub name: Option<String>,
    pub status: String,
    pub error: Option<String>,
}

pub struct Skills {
    root: PathBuf,
    runtime: NodeRuntime,
    lock: Mutex<()>,
}

impl Skills {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            runtime: NodeRuntime::default(),
            lock: Mutex::new(()),
        }
    }

    async fn executable(
        &self,
    ) -> Result<(crate::agent_management::node_runtime::PreparedNode, PathBuf), String> {
        let runtime = self
            .runtime
            .resolve(
                &self.root.join("agents/runtime"),
                &crate::agent_management::download::HttpDownloader,
                &|_| {},
            )
            .await
            .map_err(|error| error.to_string())?;
        let directory = self.root.join("tools/skills");
        let installed = directory.join(VERSION);
        let cli = installed.join("node_modules/skills/bin/cli.mjs");
        if valid_installation(&installed, &cli) {
            return Ok((runtime, cli));
        }
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let staging = tempfile::tempdir_in(&directory).map_err(|error| error.to_string())?;
        let mut npm = runtime.npm_command();
        npm.args(["install", "--prefix"])
            .arg(staging.path())
            .args([
                "--save-exact",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--",
            ])
            .arg(format!("skills@{VERSION}"));
        run(npm, INSTALL_TIMEOUT).await?;
        let staged_cli = staging.path().join("node_modules/skills/bin/cli.mjs");
        if !valid_installation(staging.path(), &staged_cli) {
            return Err("Skills 도구 설치를 확인하지 못했습니다.".into());
        }
        if installed.exists() {
            std::fs::remove_dir_all(&installed).map_err(|error| error.to_string())?;
        }
        std::fs::rename(staging.path(), &installed).map_err(|error| error.to_string())?;
        Ok((runtime, cli))
    }

    async fn execute(
        &self,
        target: &SkillTarget,
        args: &[&str],
        timeout: Duration,
    ) -> Result<String, String> {
        let cwd = target.working_directory(&self.root)?;
        let (runtime, cli) = tokio::time::timeout(INSTALL_TIMEOUT, self.executable())
            .await
            .map_err(|_| "Skills 도구 준비 시간이 초과되었습니다.".to_owned())??;
        let mut command = Command::new(runtime.node);
        command
            .arg(cli)
            .args(args)
            .current_dir(cwd)
            .env("PATH", runtime.path);
        run(command, timeout).await
    }

    pub async fn list(&self, target: SkillTarget) -> Result<Vec<SkillEntry>, String> {
        let _guard = self.lock.lock().await;
        let args = list_args(target.is_global());
        let output = self.execute(&target, &args, LIST_TIMEOUT).await?;
        let mut entries: Vec<SkillEntry> =
            parse_json_array(&output).map_err(|_| "Skills 목록 응답을 읽지 못했습니다.")?;
        tokio::task::spawn_blocking(move || {
            for entry in &mut entries {
                entry.description = read_document(&entry.path)
                    .ok()
                    .and_then(|document| document.description);
            }
            entries
        })
        .await
        .map_err(|error| error.to_string())
    }

    pub async fn document(
        &self,
        target: SkillTarget,
        path: PathBuf,
    ) -> Result<SkillDocument, String> {
        let entries = self.list(target).await?;
        if !listed_path(&entries, &path) {
            return Err("선택한 범위에서 스킬을 찾을 수 없습니다.".into());
        }
        tokio::task::spawn_blocking(move || read_document(&path))
            .await
            .map_err(|error| error.to_string())?
    }

    pub async fn install(
        &self,
        target: SkillTarget,
        source: String,
        name: String,
    ) -> Result<Vec<InstallResult>, String> {
        let source = valid_input(&source)?;
        let name = valid_input(&name)?;
        let _guard = self.lock.lock().await;
        let args = add_args(source, name, target.is_global());
        let output = self.execute(&target, &args, INSTALL_TIMEOUT).await?;
        let results: Vec<InstallResult> = parse_json_array(&output)
            .map_err(|_| "Skills 설치 응답을 읽지 못했습니다.".to_owned())?;
        if results.is_empty() || results.iter().any(|result| result.status != "installed") {
            let diagnostic = results
                .iter()
                .filter_map(|result| result.error.as_deref())
                .collect::<Vec<_>>()
                .join("; ");
            return Err(if diagnostic.is_empty() {
                "Skills 설치를 완료하지 못했습니다.".into()
            } else {
                diagnostic
            });
        }
        Ok(results)
    }

    pub async fn remove(&self, target: SkillTarget, name: String) -> Result<(), String> {
        let name = valid_input(&name)?;
        let _guard = self.lock.lock().await;
        let args = remove_args(name, target.is_global());
        self.execute(&target, &args, LIST_TIMEOUT).await.map(|_| ())
    }
}

fn listed_path(entries: &[SkillEntry], path: &Path) -> bool {
    entries.iter().any(|entry| entry.path == path)
}

fn list_args(global: bool) -> Vec<&'static str> {
    if global {
        vec!["list", "--global", "--json"]
    } else {
        vec!["list", "--json"]
    }
}

fn add_args<'a>(source: &'a str, name: &'a str, global: bool) -> Vec<&'a str> {
    let mut args = vec![
        "add", source, "--skill", name, "--agent", "*", "--yes", "--json",
    ];
    if global {
        args.push("--global");
    }
    args
}

fn remove_args(name: &str, global: bool) -> Vec<&str> {
    let mut args = vec!["remove", "--skill", name, "--yes"];
    if global {
        args.push("--global");
    }
    args
}

fn valid_input(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') {
        Err("스킬 소스와 이름을 올바르게 입력해주세요.".into())
    } else {
        Ok(value)
    }
}

fn valid_installation(root: &Path, cli: &Path) -> bool {
    if !cli.is_file() {
        return false;
    }
    let metadata = root.join("node_modules/skills/package.json");
    std::fs::read(metadata)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|package| package["version"].as_str().map(str::to_owned))
        .is_some_and(|version| version == VERSION)
}

fn read_document(directory: &Path) -> Result<SkillDocument, String> {
    let file = directory.join("SKILL.md");
    if !std::fs::symlink_metadata(&file)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_file()
    {
        return Err("SKILL.md 파일을 읽을 수 없습니다.".into());
    }
    let input = std::fs::File::open(&file).map_err(|error| error.to_string())?;
    if input.metadata().map_err(|error| error.to_string())?.len() > MAX_DOCUMENT_BYTES {
        return Err("SKILL.md 파일이 너무 큽니다.".into());
    }
    let mut bytes = Vec::new();
    input
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("SKILL.md 파일이 너무 큽니다.".into());
    }
    let content = String::from_utf8(bytes).map_err(|error| error.to_string())?;
    let parsed = Matter::<YAML>::new()
        .parse::<SkillFrontMatter>(&content)
        .map_err(|error| error.to_string())?;
    Ok(SkillDocument {
        description: parsed
            .data
            .and_then(|data| data.description)
            .filter(|description| !description.trim().is_empty()),
        markdown: parsed.content,
    })
}

// `skills add --json` prints progress before its final JSON array.
fn parse_json_array<T: serde::de::DeserializeOwned>(
    output: &str,
) -> Result<Vec<T>, serde_json::Error> {
    if let Ok(value) = serde_json::from_str(output) {
        return Ok(value);
    }
    for (index, _) in output.match_indices('[').rev() {
        if index > 0 && !output[..index].ends_with('\n') {
            continue;
        }
        if let Ok(value) = serde_json::from_str(output[index..].trim()) {
            return Ok(value);
        }
    }
    serde_json::from_str(output)
}

fn failure_diagnostic(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout = String::from_utf8_lossy(stdout);
    if let Ok(results) = parse_json_array::<InstallResult>(&stdout) {
        let errors = results
            .iter()
            .filter(|result| result.status != "installed")
            .filter_map(|result| result.error.as_deref())
            .collect::<Vec<_>>()
            .join("; ");
        if !errors.is_empty() {
            return errors;
        }
    }
    let stderr = String::from_utf8_lossy(stderr);
    let diagnostic = stderr.trim();
    if !diagnostic.is_empty() {
        return diagnostic.to_owned();
    }
    let diagnostic = stdout.trim();
    if diagnostic.is_empty() {
        "Skills 명령을 완료하지 못했습니다.".into()
    } else {
        diagnostic.to_owned()
    }
}

async fn run(mut command: Command, timeout: Duration) -> Result<String, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = command.spawn().map_err(|error| error.to_string())?;
    let mut group = ProcessGroup::new(child.id());
    let result = tokio::time::timeout(timeout, child.wait_with_output()).await;
    match result {
        Ok(Ok(output)) => {
            group.disarm();
            if output.status.success() {
                String::from_utf8(output.stdout)
                    .map_err(|_| "Skills 응답이 UTF-8이 아닙니다.".into())
            } else {
                Err(failure_diagnostic(&output.stdout, &output.stderr))
            }
        }
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("Skills 명령의 실행 시간이 초과되었습니다.".into()),
    }
}

#[tauri::command]
pub async fn list_skills(
    target: SkillTarget,
    skills: State<'_, Skills>,
    lifecycle: State<'_, crate::lifecycle::Lifecycle>,
) -> Result<Vec<SkillEntry>, String> {
    lifecycle.operation(skills.list(target)).await
}

#[tauri::command]
pub async fn read_skill_document(
    target: SkillTarget,
    path: PathBuf,
    skills: State<'_, Skills>,
    lifecycle: State<'_, crate::lifecycle::Lifecycle>,
) -> Result<SkillDocument, String> {
    lifecycle.operation(skills.document(target, path)).await
}

#[tauri::command]
pub async fn install_skill(
    target: SkillTarget,
    source: String,
    name: String,
    skills: State<'_, Skills>,
    lifecycle: State<'_, crate::lifecycle::Lifecycle>,
) -> Result<Vec<InstallResult>, String> {
    lifecycle
        .finish_before_exit(skills.install(target, source, name))
        .await
}

#[tauri::command]
pub async fn remove_skill(
    target: SkillTarget,
    name: String,
    skills: State<'_, Skills>,
    lifecycle: State<'_, crate::lifecycle::Lifecycle>,
) -> Result<(), String> {
    lifecycle
        .finish_before_exit(skills.remove(target, name))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document_fixture(content: &str) -> tempfile::TempDir {
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(folder.path().join("SKILL.md"), content).unwrap();
        folder
    }

    #[test]
    fn skill_document_reads_single_line_description_and_markdown_body() {
        let folder =
            document_fixture("---\nname: review\ndescription: Review work\n---\n# Guide\n\nBody\n");
        let document = read_document(folder.path()).unwrap();
        assert_eq!(document.description.as_deref(), Some("Review work"));
        assert!(document.markdown.starts_with("# Guide"));
        assert!(!document.markdown.contains("description:"));
    }

    #[test]
    fn skill_document_reads_folded_description_and_handles_missing_description() {
        let folder =
            document_fixture("---\ndescription: >\n  Review work\n  carefully\n---\n# Guide\n");
        assert_eq!(
            read_document(folder.path()).unwrap().description.as_deref(),
            Some("Review work carefully\n")
        );
        std::fs::write(
            folder.path().join("SKILL.md"),
            "---\nname: review\n---\n# Guide\n",
        )
        .unwrap();
        assert!(read_document(folder.path()).unwrap().description.is_none());
    }

    #[test]
    fn skill_document_rejects_missing_or_oversized_file() {
        let folder = tempfile::tempdir().unwrap();
        assert!(read_document(folder.path()).is_err());
        std::fs::write(
            folder.path().join("SKILL.md"),
            vec![b'a'; MAX_DOCUMENT_BYTES as usize + 1],
        )
        .unwrap();
        assert!(read_document(folder.path()).is_err());
    }

    #[test]
    fn skill_document_rejects_invalid_yaml_without_failing_the_list_fallback() {
        let folder = document_fixture("---\ndescription: [invalid\n---\n# Guide\n");
        assert!(read_document(folder.path()).is_err());
        let description = read_document(folder.path())
            .ok()
            .and_then(|document| document.description);
        assert!(description.is_none());
    }

    #[test]
    fn skill_document_path_must_match_listed_entry() {
        let folder = document_fixture("# Guide\n");
        let entry = SkillEntry {
            name: "review".into(),
            path: folder.path().to_owned(),
            scope: "project".into(),
            agents: vec![],
            source: None,
            source_url: None,
            source_type: None,
            description: None,
        };
        assert!(listed_path(&[entry], folder.path()));
        assert!(!listed_path(&[], folder.path()));
    }

    #[cfg(unix)]
    #[test]
    fn skill_document_does_not_follow_a_symlinked_document() {
        let folder = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), folder.path().join("SKILL.md")).unwrap();
        assert!(read_document(folder.path()).is_err());
    }

    #[test]
    fn cli_arguments_keep_agent_wildcard_and_spaces_literal() {
        assert_eq!(
            add_args("owner/repo", "review work", false),
            [
                "add",
                "owner/repo",
                "--skill",
                "review work",
                "--agent",
                "*",
                "--yes",
                "--json"
            ]
        );
        assert_eq!(
            add_args("owner/repo", "review work", true).last(),
            Some(&"--global")
        );
        assert_eq!(
            remove_args("review work", false),
            ["remove", "--skill", "review work", "--yes"]
        );
        assert_eq!(remove_args("review work", true).last(), Some(&"--global"));
        assert_eq!(list_args(true), ["list", "--global", "--json"]);
    }

    #[test]
    fn project_target_uses_exact_working_folder() {
        let folder = tempfile::tempdir().unwrap();
        let target = SkillTarget::Project {
            folder: folder.path().to_owned(),
        };
        assert_eq!(
            target.working_directory(Path::new("/unused")).unwrap(),
            folder.path()
        );
        assert!(valid_input(" -all ").is_err());
        assert!(valid_input("  ").is_err());
    }

    #[tokio::test]
    async fn command_timeout_stops_a_running_process() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "skills::tests::timeout_fixture"])
            .env("ATTE_SKILLS_TIMEOUT_FIXTURE", "1");
        assert!(run(command, Duration::from_millis(20)).await.is_err());
    }

    #[test]
    fn timeout_fixture() {
        if std::env::var_os("ATTE_SKILLS_TIMEOUT_FIXTURE").is_some() {
            std::thread::sleep(Duration::from_secs(5));
        }
    }

    #[test]
    fn parses_json_after_install_progress_and_reports_partial_failure() {
        let output = "● Installing to all agents\n\n[\n  {\"name\":\"one\",\"status\":\"installed\"},\n  {\"name\":\"two\",\"status\":\"failed\",\"error\":\"permission denied\"}\n]\n";
        let results: Vec<InstallResult> = parse_json_array(output).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(
            failure_diagnostic(output.as_bytes(), b""),
            "permission denied"
        );
        assert!(parse_json_array::<SkillEntry>("not json").is_err());
    }
}
