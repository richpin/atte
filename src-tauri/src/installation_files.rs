//! Removal is restricted to direct children of the app's managed agent directory.
use std::{io, path::Path};

pub(crate) fn validate(root: &Path, artifact: &Path) -> io::Result<()> {
    let invalid = || io::Error::other("설치 파일의 위치를 확인할 수 없습니다.");
    let parent = artifact.parent().ok_or_else(invalid)?;
    if artifact.file_name().is_none_or(|name| name == "runtime")
        || artifact
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(invalid());
    }
    let expected = root.canonicalize()?.join("agents");
    let same_parent = match parent.canonicalize() {
        Ok(actual) => actual == expected,
        Err(error) if error.kind() == io::ErrorKind::NotFound => parent == root.join("agents"),
        Err(_) => false,
    };
    if !same_parent {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) fn remove(root: &Path, artifact: &Path) -> io::Result<()> {
    validate(root, artifact)?;
    match std::fs::symlink_metadata(artifact) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(artifact),
        Ok(_) => std::fs::remove_file(artifact),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
