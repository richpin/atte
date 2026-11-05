//! Native file handles and Git's byte-oriented path boundary.
use std::{
    ffi::{OsStr, OsString},
    fs::{File, OpenOptions},
    io,
    path::Path,
};

pub(crate) fn git_path(bytes: &[u8]) -> io::Result<&OsStr> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Ok(OsStr::from_bytes(bytes))
    }
    #[cfg(windows)]
    {
        // Git for Windows emits UTF-8 paths. Reject invalid output rather than
        // replacing bytes and potentially mutating a different file.
        std::str::from_utf8(bytes)
            .map(OsStr::new)
            .map_err(io::Error::other)
    }
}

pub(crate) fn git_os_string(bytes: Vec<u8>) -> io::Result<OsString> {
    Ok(git_path(&bytes)?.to_owned())
}

pub(crate) fn open_no_follow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    }
    let file = options.open(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other("Refusing a reparse point"));
        }
    }
    Ok(file)
}

pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            from,
            rustix::fs::CWD,
            to,
            rustix::fs::RenameFlags::NOREPLACE,
        )?;
        Ok(())
    }
    #[cfg(windows)]
    {
        // Unlike Unix rename, MoveFileEx without REPLACE_EXISTING fails atomically
        // when the destination exists. std::fs::rename would overwrite it.
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        if from[..from.len() - 1].contains(&0) || to[..to.len() - 1].contains(&0) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "NUL in path"));
        }
        // SAFETY: both paths are live, NUL-terminated UTF-16 buffers.
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 0)
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
pub(crate) fn process_exists(pid: u32) -> bool {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: request query access only; a successful handle is owned and closed.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // Access/query failures cannot be treated as proof of process termination.
        return std::io::Error::last_os_error().raw_os_error() != Some(87);
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut code = 0;
    unsafe { GetExitCodeProcess(handle.as_raw_handle(), &mut code) == 0 || code == 259 }
}

/// Reject Windows aliases, device names and alternate streams before native I/O.
pub(crate) fn valid_component(name: &OsStr) -> bool {
    #[cfg(unix)]
    {
        let _ = name;
        true
    }
    #[cfg(windows)]
    {
        let Some(name) = name.to_str() else {
            return false;
        };
        if name.ends_with(['.', ' ']) || name.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c)) {
            return false;
        }
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) {
            return false;
        }
        !["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
    }
}

pub(crate) fn protected_git_component(name: &OsStr) -> bool {
    if cfg!(windows) {
        let name = name.to_string_lossy().to_ascii_lowercase();
        name == ".git"
            || name.strip_prefix("git~").is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|c| c.is_ascii_digit())
            })
    } else {
        name == ".git"
    }
}
