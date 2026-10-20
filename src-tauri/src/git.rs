//! System Git transport. Callers own command semantics and output decoding.
use std::ffi::OsStr;
use std::path::Path;
use std::process::{Command, ExitStatus, Output, Stdio};

#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("Git을 실행할 수 없습니다: {0}")]
    Execution(#[from] std::io::Error),
    #[error("{}", String::from_utf8_lossy(stderr).trim())]
    Failed { status: ExitStatus, stderr: Vec<u8> },
}

fn command(folder: &Path, args: &[&OsStr]) -> Command {
    let mut command = Command::new("git");
    // Git hooks export repository-local settings. They must not redirect commands
    // for another checkout (notably GIT_INDEX_FILE=.git/index in a linked worktree).
    // These are the variables reported by `git rev-parse --local-env-vars`.
    for variable in [
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_COUNT",
        "GIT_OBJECT_DIRECTORY",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_IMPLICIT_WORK_TREE",
        "GIT_GRAFT_FILE",
        "GIT_INDEX_FILE",
        "GIT_NO_REPLACE_OBJECTS",
        "GIT_REPLACE_REF_BASE",
        "GIT_PREFIX",
        "GIT_SHALLOW_FILE",
        "GIT_COMMON_DIR",
    ] {
        command.env_remove(variable);
    }
    command
        .arg("--no-pager")
        .arg("-C")
        .arg(folder)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    command
}

fn stdout(output: Output) -> Result<Vec<u8>, Error> {
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(Error::Failed {
            status: output.status,
            stderr: output.stderr,
        })
    }
}

/// Execute without a shell, preserving stdout bytes (including NULs and newlines).
pub(crate) async fn run(folder: &Path, args: &[&OsStr]) -> Result<Vec<u8>, Error> {
    let output = tokio::process::Command::from(command(folder, args))
        .kill_on_drop(true)
        .output()
        .await?;
    stdout(output)
}

/// Stream output with pipe backpressure; dropping the child also stops Git.
pub(crate) fn spawn(folder: &Path, args: &[&OsStr]) -> Result<tokio::process::Child, Error> {
    Ok(tokio::process::Command::from(command(folder, args))
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?)
}

/// Execute from a blocking worker; never call on an async runtime worker.
pub(crate) fn run_blocking(folder: &Path, args: &[&OsStr]) -> Result<Vec<u8>, Error> {
    stdout(command(folder, args).output()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transports_preserve_delimiters_and_literal_arguments() {
        let folder = tempfile::tempdir().unwrap();
        let args = [
            "-c".as_ref(),
            "atte.value=line one\n$(literal); `literal`\n".as_ref(),
            "config".as_ref(),
            "--null".as_ref(),
            "--get".as_ref(),
            "atte.value".as_ref(),
        ];
        let expected = b"line one\n$(literal); `literal`\n\0";
        assert_eq!(run(folder.path(), &args).await.unwrap(), expected);
        assert_eq!(run_blocking(folder.path(), &args).unwrap(), expected);
    }

    #[tokio::test]
    async fn failed_commands_retain_status_and_diagnostics() {
        let folder = tempfile::tempdir().unwrap();
        let error = run(folder.path(), &["not-an-atte-command".as_ref()])
            .await
            .unwrap_err();
        let Error::Failed { status, stderr } = error else {
            panic!("expected a Git exit failure");
        };
        assert!(!status.success());
        assert!(!stderr.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdout_need_not_be_utf8() {
        use std::os::unix::ffi::OsStrExt;
        let folder = tempfile::tempdir().unwrap();
        let value = OsStr::from_bytes(b"atte.value=\xff");
        let args = [
            "-c".as_ref(),
            value,
            "config".as_ref(),
            "--get".as_ref(),
            "atte.value".as_ref(),
        ];
        assert_eq!(run(folder.path(), &args).await.unwrap(), b"\xff\n");
    }
    #[tokio::test]
    async fn ignores_repository_environment_inherited_from_a_git_hook() {
        const PROBE: &str = "ATTE_GIT_ENV_PROBE";
        if let Some(folder) = std::env::var_os(PROBE) {
            let folder = std::path::PathBuf::from(folder);
            let args = ["rev-parse".as_ref(), "--show-toplevel".as_ref()];
            let expected = format!("{}\n", folder.display()).into_bytes();
            assert_eq!(run(&folder, &args).await.unwrap(), expected);
            assert_eq!(run_blocking(&folder, &args).unwrap(), expected);
            run(&folder, &["add".as_ref(), "file".as_ref()])
                .await
                .unwrap();
            assert!(folder.join(".git/index").is_file());
            return;
        }
        let folder = tempfile::tempdir().unwrap();
        let folder = folder.path().canonicalize().unwrap();
        run(&folder, &["init".as_ref(), "--quiet".as_ref()])
            .await
            .unwrap();
        std::fs::write(folder.join("file"), "content").unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "git::tests::ignores_repository_environment_inherited_from_a_git_hook",
                "--nocapture",
            ])
            .env(PROBE, &folder)
            .env("GIT_DIR", folder.join("missing-repository"))
            .env("GIT_WORK_TREE", folder.join("wrong-working-tree"))
            .env("GIT_INDEX_FILE", ".git/index")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
}
