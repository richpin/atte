use sha2::{Digest, Sha256};
use std::path::Path;

pub trait Credentials: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

pub struct NativeCredentials;
impl Credentials for NativeCredentials {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match native_entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(
                "Credential unavailable; unlock the OS credential store or replace the secret"
                    .into(),
            ),
        }
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        native_entry(account)?
            .set_password(value)
            .map_err(|_| "Cannot save secret in the OS credential store".into())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        match native_entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Cannot delete secret from the OS credential store".into()),
        }
    }
}
fn native_entry(account: &str) -> Result<keyring::Entry, String> {
    if !cfg!(any(target_os = "macos", windows)) {
        return Err("OS credential storage is unavailable on this platform".into());
    }
    keyring::Entry::new("app.atte.mcp", account)
        .map_err(|_| "OS credential store unavailable".into())
}

pub fn account(path: &Path, server: &str, reference: &str) -> String {
    let mut hash = Sha256::new();
    for part in [
        path.to_string_lossy().as_bytes(),
        server.as_bytes(),
        reference.as_bytes(),
    ] {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    format!("{:x}", hash.finalize())
}
