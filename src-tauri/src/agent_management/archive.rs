use super::ManagementError;
use std::{
    fs::File,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
const MAX_EXPANDED: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;

pub(crate) fn supported_url(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    let path = url.path().to_lowercase();
    if [".zip", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
    {
        return true;
    }
    ![
        ".dmg",
        ".pkg",
        ".deb",
        ".rpm",
        ".msi",
        ".appimage",
        ".xz",
        ".gz",
        ".bz2",
        ".tar",
        ".7z",
        ".rar",
    ]
    .iter()
    .any(|suffix| path.ends_with(suffix))
}

pub(crate) fn enclosed(root: &Path, relative: &Path) -> Result<PathBuf, ManagementError> {
    if relative.as_os_str().is_empty() || relative.has_root() || relative.components().any(|part| {
        matches!(part, Component::ParentDir | Component::Prefix(_))
            || matches!(part, Component::Normal(name) if !crate::platform::valid_component(name))
    }) {
        return Err(ManagementError::Integrity);
    }
    Ok(root.join(relative))
}

pub(crate) fn extract(
    archive: &Path,
    url: &str,
    output: &Path,
    raw_cmd: &str,
) -> Result<(), ManagementError> {
    if !supported_url(url) {
        return Err(ManagementError::Unsupported);
    }
    let path = reqwest::Url::parse(url)
        .map_err(|_| ManagementError::Registry)?
        .path()
        .to_lowercase();
    let file = File::open(archive).map_err(|_| ManagementError::Install)?;
    let mut budget = MAX_EXPANDED;
    if path.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(file).map_err(|_| ManagementError::Integrity)?;
        if zip.len() > MAX_ENTRIES {
            return Err(ManagementError::Integrity);
        }
        for index in 0..zip.len() {
            let mut entry = zip
                .by_index(index)
                .map_err(|_| ManagementError::Integrity)?;
            if entry.is_symlink() {
                return Err(ManagementError::Integrity);
            }
            let destination = enclosed(
                output,
                &entry.enclosed_name().ok_or(ManagementError::Integrity)?,
            )?;
            if entry.is_dir() {
                std::fs::create_dir_all(destination).map_err(|_| ManagementError::Install)?;
            } else {
                let mode = entry.unix_mode().unwrap_or(0o644);
                write_entry(&mut entry, &destination, mode, &mut budget)?;
            }
        }
    } else if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
        extract_tar(flate2::read::GzDecoder::new(file), output, &mut budget)?;
    } else if path.ends_with(".tar.bz2") || path.ends_with(".tbz2") {
        extract_tar(bzip2::read::BzDecoder::new(file), output, &mut budget)?;
    } else {
        write_entry(
            &mut &file,
            &enclosed(output, Path::new(raw_cmd))?,
            0o755,
            &mut budget,
        )?;
    }
    Ok(())
}

fn extract_tar(reader: impl Read, output: &Path, budget: &mut u64) -> Result<(), ManagementError> {
    std::fs::create_dir_all(output).map_err(|_| ManagementError::Install)?;
    let root = output
        .canonicalize()
        .map_err(|_| ManagementError::Install)?;
    let mut archive = tar::Archive::new(reader);
    archive.set_overwrite(false);
    archive.set_mask(0o7000);
    archive.set_preserve_mtime(false);
    let mut links = Vec::new();
    for (index, entry) in archive
        .entries()
        .map_err(|_| ManagementError::Integrity)?
        .enumerate()
    {
        if index >= MAX_ENTRIES {
            return Err(ManagementError::Integrity);
        }
        let mut entry = entry.map_err(|_| ManagementError::Integrity)?;
        let path = entry
            .path()
            .map_err(|_| ManagementError::Integrity)?
            .into_owned();
        let destination = enclosed(output, &path)?;
        let kind = entry.header().entry_type();
        if kind.is_file() {
            *budget = budget
                .checked_sub(entry.size())
                .ok_or(ManagementError::Integrity)?;
        } else if kind.is_symlink() || kind.is_hard_link() {
            let target = entry
                .link_name()
                .map_err(|_| ManagementError::Integrity)?
                .ok_or(ManagementError::Integrity)?;
            if target.as_os_str().is_empty() || target.has_root() || target.components().any(|part| {
                matches!(part, Component::Prefix(_))
                    || matches!(part, Component::Normal(name) if !crate::platform::valid_component(name))
            }) {
                return Err(ManagementError::Integrity);
            }
            links.push(destination);
        } else if !kind.is_dir() {
            return Err(ManagementError::Integrity);
        }
        // tar validates each destination's resolved parent, including paths through
        // earlier links. Keep extraction inside staging without reimplementing it.
        if !entry
            .unpack_in(&root)
            .map_err(|_| ManagementError::Integrity)?
        {
            return Err(ManagementError::Integrity);
        }
    }
    // Forward links and framework chains may only resolve once all entries exist.
    // No dangling, cyclic, or external links may leave the staging boundary.
    for link in links {
        let target = link
            .canonicalize()
            .map_err(|_| ManagementError::Integrity)?;
        if !target.starts_with(&root) {
            return Err(ManagementError::Integrity);
        }
    }
    Ok(())
}

fn write_entry(
    reader: &mut impl Read,
    path: &Path,
    mode: u32,
    budget: &mut u64,
) -> Result<(), ManagementError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| ManagementError::Install)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| ManagementError::Integrity)?;
    let copied = std::io::copy(&mut reader.take(budget.saturating_add(1)), &mut file)
        .map_err(|_| ManagementError::Integrity)?;
    *budget = budget
        .checked_sub(copied)
        .ok_or(ManagementError::Integrity)?;
    file.flush().map_err(|_| ManagementError::Install)?;
    executable_mode(path, mode & 0o777)?;
    Ok(())
}

#[cfg(unix)]
pub(crate) fn executable_mode(path: &Path, mode: u32) -> Result<(), ManagementError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|_| ManagementError::Install)
}

#[cfg(windows)]
pub(crate) fn executable_mode(_path: &Path, _mode: u32) -> Result<(), ManagementError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unpack_fixture(bytes: &[u8], output: &Path) -> Result<(), ManagementError> {
        let mut budget = MAX_EXPANDED;
        extract_tar(bytes, output, &mut budget)
    }

    fn tar_fixture(files: &[(&str, &[u8])], links: &[(&str, &str)]) -> Vec<u8> {
        let mut archive = tar::Builder::new(Vec::new());
        // Links before their targets reproduce framework archives as well as CLI aliases.
        for (path, target) in links {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            archive.append_link(&mut header, path, target).unwrap();
        }
        for (path, bytes) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            archive.append_data(&mut header, path, *bytes).unwrap();
        }
        archive.into_inner().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn tar_preserves_cli_aliases_and_python_framework_links() {
        let bytes = tar_fixture(
            &[
                ("harn", b"cli"),
                ("_internal/Python.framework/Versions/3.13/Python", b"python"),
            ],
            &[
                ("harn-dap", "harn"),
                ("harn-lsp", "harn"),
                ("_internal/Python", "Python.framework/Python"),
                (
                    "_internal/Python.framework/Python",
                    "Versions/Current/Python",
                ),
                ("_internal/Python.framework/Versions/Current", "3.13"),
                ("_internal/lib/Python", "../Python"),
            ],
        );
        let root = tempfile::tempdir().unwrap();
        unpack_fixture(&bytes, root.path()).unwrap();
        assert_eq!(std::fs::read(root.path().join("harn-dap")).unwrap(), b"cli");
        assert_eq!(
            std::fs::read(root.path().join("_internal/lib/Python")).unwrap(),
            b"python"
        );
        assert!(std::fs::symlink_metadata(root.path().join("harn-lsp"))
            .unwrap()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn tar_rejects_external_dangling_and_cyclic_links() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("sentinel"), b"unchanged").unwrap();
        for links in [
            vec![("alias", outside.path().to_str().unwrap())],
            vec![("alias", "../outside")],
            vec![("alias", "missing")],
            vec![("a", "b"), ("b", "a")],
            // Lexically internal, but resolves outside after following the first link.
            vec![("a", "."), ("b", "a/../outside")],
        ] {
            let root = tempfile::tempdir().unwrap();
            let bytes = tar_fixture(&[], &links);
            assert!(
                matches!(
                    unpack_fixture(&bytes, root.path()),
                    Err(ManagementError::Integrity)
                ),
                "{links:?}"
            );
        }
        assert_eq!(
            std::fs::read(outside.path().join("sentinel")).unwrap(),
            b"unchanged"
        );
    }

    #[cfg(unix)]
    #[test]
    fn tar_cannot_write_through_an_external_link_or_replace_a_link() {
        let parent = tempfile::tempdir().unwrap();
        let outside = parent.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let escaped = outside.join("sentinel");
        std::fs::write(&escaped, b"unchanged").unwrap();
        for files in [
            vec![("alias/sentinel", b"overwrite".as_slice())],
            vec![("alias", b"overwrite".as_slice())],
        ] {
            let root = tempfile::tempdir_in(parent.path()).unwrap();
            let bytes = tar_fixture(&files, &[("alias", "../outside")]);
            assert!(unpack_fixture(&bytes, root.path()).is_err());
            assert_eq!(std::fs::read(&escaped).unwrap(), b"unchanged");
        }
        let root = tempfile::tempdir().unwrap();
        let bytes = tar_fixture(
            &[("alias", b"overwrite"), ("file", b"original")],
            &[("alias", "file")],
        );
        assert!(unpack_fixture(&bytes, root.path()).is_err());
    }

    #[test]
    fn tar_enforces_expanded_budget_and_rejects_special_files() {
        let root = tempfile::tempdir().unwrap();
        let bytes = tar_fixture(&[("large", b"12345")], &[]);
        assert!(matches!(
            extract_tar(bytes.as_slice(), root.path(), &mut 4),
            Err(ManagementError::Integrity)
        ));
        assert!(!root.path().join("large").exists());

        let mut archive = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Fifo);
        header.set_size(0);
        archive
            .append_data(&mut header, "fifo", std::io::empty())
            .unwrap();
        let bytes = archive.into_inner().unwrap();
        assert!(matches!(
            unpack_fixture(&bytes, root.path()),
            Err(ManagementError::Integrity)
        ));
    }

    #[test]
    fn tar_creates_the_runtime_output_directory_and_preserves_hard_links() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("unpacked");
        let bytes = tar_fixture(&[("bin/node", b"runtime")], &[]);
        let mut archive = tar::Builder::new(Vec::new());
        for entry in tar::Archive::new(bytes.as_slice()).entries().unwrap() {
            let mut entry = entry.unwrap();
            let header = entry.header().clone();
            archive.append(&header, &mut entry).unwrap();
        }
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Link);
        header.set_size(0);
        archive
            .append_link(&mut header, "bin/alias", "bin/node")
            .unwrap();
        let bytes = archive.into_inner().unwrap();
        unpack_fixture(&bytes, &output).unwrap();
        assert_eq!(std::fs::read(output.join("bin/alias")).unwrap(), b"runtime");
    }

    #[test]
    fn extraction_paths_stay_inside_the_installation() {
        let root = tempfile::tempdir().unwrap();
        for path in ["../escape", "/escape", ""] {
            assert!(enclosed(root.path(), Path::new(path)).is_err(), "{path}");
        }
        assert_eq!(
            enclosed(root.path(), Path::new("./bin/agent")).unwrap(),
            root.path().join("./bin/agent")
        );
        #[cfg(windows)]
        for path in [
            r"\outside\agent.exe",
            r"C:agent.exe",
            r"C:\outside\agent.exe",
            "file:stream",
            "NUL",
            "folder. /agent",
        ] {
            assert!(enclosed(root.path(), Path::new(path)).is_err(), "{path}");
        }
    }
}
