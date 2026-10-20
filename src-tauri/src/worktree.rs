//! Git checkout preparation, independent of thread state and desktop transport.
use crate::git;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub source_folder: PathBuf,
    pub root: PathBuf,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkingMode {
    #[default]
    Local,
    Worktree,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub repository_root: Option<PathBuf>,
    pub commit: Option<String>,
    pub unavailable_reason: Option<&'static str>,
}

async fn query(folder: &Path, args: &[&str]) -> Result<String, String> {
    let output = git::run(
        folder,
        &args.iter().map(std::ffi::OsStr::new).collect::<Vec<_>>(),
    )
    .await
    .map_err(|error| error.to_string())?;
    String::from_utf8(output)
        .map(|value| value.trim_end_matches('\n').to_owned())
        .map_err(|_| "Git 경로를 읽을 수 없습니다.".to_owned())
}

pub async fn inspect(folder: &Path) -> FolderInfo {
    let unavailable = |reason| FolderInfo {
        repository_root: None,
        commit: None,
        unavailable_reason: Some(reason),
    };
    if !folder.is_dir() {
        return unavailable("invalidFolder");
    }
    if query(folder, &["--version"]).await.is_err() {
        return unavailable("gitUnavailable");
    }
    match query(folder, &["rev-parse", "--is-bare-repository"]).await {
        Ok(value) if value == "true" => return unavailable("bareRepository"),
        Err(_) => return unavailable("notRepository"),
        _ => {}
    }
    let Ok(root) = query(folder, &["rev-parse", "--show-toplevel"]).await else {
        return unavailable("notRepository");
    };
    let Ok(commit) = query(folder, &["rev-parse", "--verify", "HEAD^{commit}"]).await else {
        return unavailable("noCommit");
    };
    FolderInfo {
        repository_root: Some(PathBuf::from(root)),
        commit: Some(commit),
        unavailable_reason: None,
    }
}

pub struct PreparedWorktree {
    pub metadata: Worktree,
    pub working_folder: PathBuf,
}

impl PreparedWorktree {
    pub async fn create(source: &Path, parent: &Path, id: Uuid) -> Result<Self, String> {
        let source = source.canonicalize().map_err(|error| error.to_string())?;
        let info = inspect(&source).await;
        let (Some(repository), Some(commit)) = (info.repository_root, info.commit) else {
            return Err(match info.unavailable_reason {
                Some("gitUnavailable") => "Git을 실행할 수 없습니다. Git 설치를 확인해주세요.",
                Some("noCommit") => "Worktree를 만들려면 먼저 커밋을 만들어주세요.",
                Some("bareRepository") => "bare 저장소에서는 worktree를 시작할 수 없습니다.",
                _ => "Git 저장소 안의 폴더를 선택해주세요.",
            }
            .into());
        };
        let repository = repository
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let relative = source
            .strip_prefix(&repository)
            .map_err(|error| error.to_string())?;
        let name = repository
            .file_name()
            .ok_or("저장소 이름을 확인할 수 없습니다.")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let parent = parent.canonicalize().map_err(|error| error.to_string())?;
        let container = parent.join(id.to_string());
        std::fs::create_dir(&container).map_err(|error| error.to_string())?;
        let root = container.join(name);
        let prepared = Self {
            working_folder: root.join(relative),
            metadata: Worktree {
                source_folder: source.clone(),
                root,
            },
        };
        let result = git::run(
            &repository,
            &[
                "worktree".as_ref(),
                "add".as_ref(),
                "--detach".as_ref(),
                prepared.metadata.root.as_os_str(),
                commit.as_ref(),
            ],
        )
        .await;
        if let Err(error) = result {
            // Git normally rolls back failed additions. Never remove unexpected files.
            if !prepared.metadata.root.exists() {
                let _ = std::fs::remove_dir(&container);
                return Err(error.to_string());
            }
            return Err(prepared.rollback_error(error.to_string()).await);
        }
        if !prepared.working_folder.is_dir() {
            return Err(prepared
                .rollback_error("선택한 하위 폴더가 HEAD 커밋에 없습니다.".into())
                .await);
        }
        if !prepared
            .working_folder
            .canonicalize()
            .is_ok_and(|folder| folder.starts_with(&prepared.metadata.root))
        {
            return Err(prepared
                .rollback_error("선택한 하위 폴더가 worktree 밖을 가리킵니다.".into())
                .await);
        }
        Ok(prepared)
    }

    pub async fn rollback_error(&self, error: String) -> String {
        match git::run(
            &self.metadata.source_folder,
            &[
                "worktree".as_ref(),
                "remove".as_ref(),
                self.metadata.root.as_os_str(),
            ],
        )
        .await
        {
            Ok(_) => {
                if let Some(parent) = self.metadata.root.parent() {
                    let _ = std::fs::remove_dir(parent);
                }
                error
            }
            Err(cleanup) => format!(
                "{error}\nWorktree 정리에 실패했습니다. 보존된 경로: {}\n{cleanup}",
                self.metadata.root.display()
            ),
        }
    }
}

pub fn validate(worktree: &Worktree, folder: &Path) -> Result<(), String> {
    // Validate the linked checkout itself, rather than accepting a directory recreated at its path.
    if !worktree.root.join(".git").is_file() {
        return Err(format!(
            "Worktree를 사용할 수 없습니다: {}",
            worktree.root.display()
        ));
    }
    let output = git::run_blocking(
        &worktree.root,
        &["rev-parse".as_ref(), "--show-toplevel".as_ref()],
    )
    .map_err(|error| {
        format!(
            "Worktree를 사용할 수 없습니다: {}\n{error}",
            worktree.root.display()
        )
    })?;
    let root = String::from_utf8_lossy(&output);
    if Path::new(root.trim_end_matches('\n')) != worktree.root
        || !folder.is_dir()
        || !folder.starts_with(&worktree.root)
        || !folder
            .canonicalize()
            .is_ok_and(|folder| folder.starts_with(&worktree.root))
    {
        return Err(format!(
            "Worktree를 사용할 수 없습니다: {}",
            worktree.root.display()
        ));
    }
    Ok(())
}

/// Removes an unreferenced managed checkout after its agent processes have stopped.
/// Creation rollback deliberately uses a separate, non-forced removal path.
pub async fn remove(worktree: &Worktree) -> Result<(), String> {
    let remove = async {
        let parent = worktree
            .root
            .parent()
            .ok_or("Worktree 경로가 올바르지 않습니다.")?;
        let container_id = parent
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| Uuid::parse_str(name).ok());
        if !container_id
            .is_some_and(|id| parent.file_name() == Some(std::ffi::OsStr::new(&id.to_string())))
            || parent.is_symlink()
        {
            return Err("Worktree 경로가 올바르지 않습니다.".to_owned());
        }
        let exists = match std::fs::symlink_metadata(&worktree.root) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err("Worktree 경로가 올바르지 않습니다.".to_owned());
                }
                let checkout = worktree.clone();
                tokio::task::spawn_blocking(move || validate(&checkout, &checkout.root))
                    .await
                    .map_err(|error| error.to_string())??;
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.to_string()),
        };
        let folder = if exists {
            &worktree.root
        } else {
            &worktree.source_folder
        };
        let result = git::run(
            folder,
            &[
                "worktree".as_ref(),
                "remove".as_ref(),
                "--force".as_ref(),
                worktree.root.as_os_str(),
            ],
        )
        .await;
        if let Err(error) = result {
            if exists {
                return Err(error.to_string());
            }
            // An externally removed and already pruned checkout is also gone.
            let listed = git::run(
                folder,
                &[
                    "worktree".as_ref(),
                    "list".as_ref(),
                    "--porcelain".as_ref(),
                    "-z".as_ref(),
                ],
            )
            .await
            .map_err(|error| error.to_string())?;
            if listed.split(|byte| *byte == 0).any(|field| {
                field.strip_prefix(b"worktree ")
                    == Some(worktree.root.as_os_str().as_encoded_bytes())
            }) {
                return Err(error.to_string());
            }
        }
        if worktree
            .root
            .try_exists()
            .map_err(|error| error.to_string())?
        {
            return Err("Worktree 폴더가 남아 있습니다.".to_owned());
        }
        // Checkout removal is complete. Finder metadata and its empty UUID container
        // are best-effort housekeeping; unrelated sibling files must be preserved.
        let _ = std::fs::remove_file(parent.join(".DS_Store"));
        let _ = std::fs::remove_dir(parent);
        Ok(())
    }
    .await;
    remove.map_err(|error: String| {
        format!(
            "Worktree 삭제에 실패했습니다: {}\n{error}",
            worktree.root.display()
        )
    })
}
