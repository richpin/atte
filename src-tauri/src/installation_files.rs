//! Removal is restricted to legacy artifacts or immutable agent installation directories.
use std::{io, path::Path};

pub(crate) fn validate(root: &Path, artifact: &Path) -> io::Result<()> {
    let invalid = || io::Error::other("설치 파일의 위치를 확인할 수 없습니다.");
    let agents = root.canonicalize()?.join("agents");
    let normalized = match artifact.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = artifact.parent().ok_or_else(invalid)?;
            let parent = parent.canonicalize().unwrap_or_else(|_| parent.to_owned());
            parent.join(artifact.file_name().ok_or_else(invalid)?)
        }
        Err(error) => return Err(error),
    };
    let relative = normalized.strip_prefix(&agents).map_err(|_| invalid())?;
    let components: Vec<_> = relative.components().collect();
    if !(components.len() == 1 || components.len() == 2)
        || components
            .first()
            .is_some_and(|part| part.as_os_str() == "runtime")
        || components.iter().any(|part| {
            matches!(part, std::path::Component::ParentDir)
                || part.as_os_str().to_string_lossy().starts_with(".staging-")
        })
    {
        return Err(invalid());
    }
    if !normalized.starts_with(&agents) {
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
