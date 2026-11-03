//! Preserve local state when the macOS bundle identifier changes.
use std::{io, path::Path};

pub(crate) fn migrate_previous_identifier(current: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let previous = current.with_file_name("com.atte.app");
        if !current.exists() && previous.is_dir() {
            std::fs::rename(previous, current)?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = current;
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn moves_existing_app_data_to_the_new_identifier() {
        let root = tempfile::tempdir().unwrap();
        let previous = root.path().join("com.atte.app");
        std::fs::create_dir(&previous).unwrap();
        std::fs::write(previous.join("atte.sqlite"), b"existing state").unwrap();
        let current = root.path().join("com.atte.desktop");

        migrate_previous_identifier(&current).unwrap();

        assert_eq!(
            std::fs::read(current.join("atte.sqlite")).unwrap(),
            b"existing state"
        );
    }

    #[test]
    fn preserves_both_folders_when_new_app_data_already_exists() {
        let root = tempfile::tempdir().unwrap();
        let previous = root.path().join("com.atte.app");
        let current = root.path().join("com.atte.desktop");
        std::fs::create_dir(&previous).unwrap();
        std::fs::create_dir(&current).unwrap();
        std::fs::write(current.join("atte.sqlite"), b"new state").unwrap();

        migrate_previous_identifier(&current).unwrap();

        assert_eq!(
            std::fs::read(current.join("atte.sqlite")).unwrap(),
            b"new state"
        );
        assert!(previous.is_dir());
    }
}
