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
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(ManagementError::Integrity);
    }
    Ok(root.join(relative))
}

pub(crate) fn extract(
    archive: &Path,
    url: &str,
    output: &Path,
    raw_cmd: &str,
    node_archive: bool,
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
        extract_tar(
            flate2::read::GzDecoder::new(file),
            output,
            node_archive,
            &mut budget,
        )?;
    } else if path.ends_with(".tar.bz2") || path.ends_with(".tbz2") {
        extract_tar(
            bzip2::read::BzDecoder::new(file),
            output,
            node_archive,
            &mut budget,
        )?;
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

fn extract_tar(
    reader: impl Read,
    output: &Path,
    node_archive: bool,
    budget: &mut u64,
) -> Result<(), ManagementError> {
    let mut archive = tar::Archive::new(reader);
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
        if kind.is_dir() {
            std::fs::create_dir_all(destination).map_err(|_| ManagementError::Install)?;
        } else if kind.is_file() {
            let mode = entry
                .header()
                .mode()
                .map_err(|_| ManagementError::Integrity)?;
            write_entry(&mut entry, &destination, mode, budget)?;
        } else if node_archive && kind.is_symlink() {
            // Official Node archives contain bin/npm and bin/npx links. We invoke their JS files directly.
            // Do not materialize any archive link, including these trusted runtime links.
        } else {
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

pub(crate) fn executable_mode(path: &Path, mode: u32) -> Result<(), ManagementError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|_| ManagementError::Install)
}
