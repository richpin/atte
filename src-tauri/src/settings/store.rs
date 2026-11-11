//! Serialized settings persistence and legacy migration, independent of Tauri.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::ErrorKind, path::PathBuf};
use tokio::sync::mpsc;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Theme {
    #[default]
    System,
    Light,
    Dark,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Locale {
    #[default]
    System,
    En,
    Ko,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub(crate) struct Values {
    pub theme: Theme,
    pub locale: Locale,
    pub notifications: NotificationValues,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub(crate) struct NotificationValues {
    pub completion: bool,
    pub permission: bool,
}
impl Default for NotificationValues {
    fn default() -> Self {
        Self {
            completion: true,
            permission: true,
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Legacy {
    theme: Option<Theme>,
    locale: Option<Locale>,
}
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Patch {
    theme: Option<Theme>,
    locale: Option<Locale>,
    notifications: Option<NotificationPatch>,
}
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct NotificationPatch {
    completion: Option<bool>,
    permission: Option<bool>,
}
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub values: Values,
    pub error: Option<String>,
    pub migrated: bool,
}

pub(super) struct Store {
    path: PathBuf,
    legacy_path: PathBuf,
    legacy: Legacy,
    initialized: bool,
    write_error: Option<String>,
    snapshot: Snapshot,
    subscribers: Vec<mpsc::UnboundedSender<Snapshot>>,
}
impl Store {
    pub(super) fn new(path: PathBuf, legacy_path: PathBuf) -> Self {
        Self {
            path,
            legacy_path,
            legacy: Legacy::default(),
            initialized: false,
            write_error: None,
            snapshot: Snapshot::default(),
            subscribers: Vec::new(),
        }
    }

    fn read(&self) -> Result<(Option<Vec<u8>>, Value), String> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(format!("Cannot read settings: {error}")),
        };
        let document = match &bytes {
            Some(bytes) => serde_json::from_slice(bytes)
                .map_err(|error| format!("Invalid settings JSON: {error}"))?,
            None => json!({}),
        };
        Self::validate(&document)?;
        Ok((bytes, document))
    }

    fn validate(document: &Value) -> Result<Values, String> {
        if !document.is_object() {
            return Err("Settings must be a JSON object".into());
        }
        if document
            .get("notifications")
            .is_some_and(|value| !value.is_object())
        {
            return Err("notifications must be a JSON object".into());
        }
        if document
            .get("mcpServers")
            .is_some_and(|value| !value.is_object())
        {
            return Err("mcpServers must be a JSON object".into());
        }
        serde_json::from_value(document.clone())
            .map_err(|error| format!("Invalid settings: {error}"))
    }

    fn write(&self, before: &Option<Vec<u8>>, document: &Value) -> Result<(), String> {
        let parent = self.path.parent().ok_or("Settings directory unavailable")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut file =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        serde_json::to_writer_pretty(file.as_file_mut(), document)
            .map_err(|error| error.to_string())?;
        file.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        let current = match std::fs::read(&self.path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        if &current != before {
            return Err("Settings changed while saving. Retry the change.".into());
        }
        file.persist(&self.path)
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn load(&mut self) -> Result<(), String> {
        let (before, mut document) = self.read()?;
        if !self.snapshot.migrated {
            let needs_notifications = document.get("notifications").is_none_or(|value| {
                value.get("completion").is_none() || value.get("permission").is_none()
            });
            let old = if needs_notifications {
                match std::fs::read(&self.legacy_path) {
                    Ok(bytes) => Some(bytes),
                    Err(error) if error.kind() == ErrorKind::NotFound => None,
                    Err(error) => {
                        return Err(format!("Cannot read previous notifications: {error}"))
                    }
                }
            } else {
                None
            };
            let preferences = if needs_notifications {
                old.as_ref()
                    .map(|bytes| serde_json::from_slice::<crate::notifications::Preferences>(bytes))
                    .transpose()
                    .map_err(|error| format!("Invalid previous notifications: {error}"))?
            } else {
                None
            };
            let defaults = json!({
                "theme": self.legacy.theme.unwrap_or_default(),
                "locale": self.legacy.locale.unwrap_or_default(),
                "notifications": preferences.unwrap_or_default(),
                "mcpServers": {}
            });
            let previous = document.clone();
            fill_missing(&mut document, &defaults);
            if before.is_none() || document != previous {
                self.write(&before, &document)?;
            }
            self.snapshot.values = Self::validate(&document)?;
            match std::fs::remove_file(&self.legacy_path) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) if old.is_some() => {
                    return Err(format!("Cannot clean up previous notifications: {error}"))
                }
                Err(error) => eprintln!(
                    "Unused previous notification settings could not be cleaned up: {error}"
                ),
            }
            self.snapshot.migrated = true;
        }
        self.snapshot.values = Self::validate(&document)?;
        Ok(())
    }

    pub(super) fn initialize(&mut self, legacy: Legacy) {
        self.legacy = legacy;
        self.initialized = true;
        self.write_error = None;
        self.refresh();
    }

    pub(super) fn initialized(&self) -> bool {
        self.initialized
    }

    pub(super) fn refresh(&mut self) {
        let before = self.snapshot.clone();
        self.snapshot.error = self.load().err().or_else(|| self.write_error.clone());
        if self.snapshot != before {
            self.publish();
        }
    }

    pub(super) fn patch(&mut self, patch: Patch) -> Result<(), String> {
        if let Some(error) = &self.snapshot.error {
            return Err(error.clone());
        }
        let result = (|| {
            let (before, mut document) = self.read()?;
            if let Some(theme) = patch.theme {
                document["theme"] = json!(theme);
            }
            if let Some(locale) = patch.locale {
                document["locale"] = json!(locale);
            }
            if let Some(notifications) = patch.notifications {
                if document.get("notifications").is_none() {
                    document["notifications"] = json!({});
                }
                if let Some(value) = notifications.completion {
                    document["notifications"]["completion"] = json!(value);
                }
                if let Some(value) = notifications.permission {
                    document["notifications"]["permission"] = json!(value);
                }
            }
            let values = Self::validate(&document)?;
            if let Err(error) = self.write(&before, &document) {
                self.write_error = Some(error.clone());
                return Err(error);
            }
            self.snapshot.values = values;
            Ok(())
        })();
        self.snapshot.error = result.as_ref().err().cloned();
        self.publish();
        result
    }

    fn publish(&mut self) {
        self.subscribers
            .retain(|sender| sender.send(self.snapshot.clone()).is_ok());
    }
    pub(super) fn subscribe(&mut self) -> mpsc::UnboundedReceiver<Snapshot> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let _ = sender.send(self.snapshot.clone());
        self.subscribers.retain(|sender| !sender.is_closed());
        self.subscribers.push(sender);
        receiver
    }
}

fn fill_missing(document: &mut Value, defaults: &Value) {
    if let (Some(document), Some(defaults)) = (document.as_object_mut(), defaults.as_object()) {
        for (key, value) in defaults {
            if let Some(existing) = document.get_mut(key) {
                fill_missing(existing, value);
            } else {
                document.insert(key.clone(), value.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests;
