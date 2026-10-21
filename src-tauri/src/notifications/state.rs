//! Notification policy, independent of AppKit and the webview lifetime.
use crate::thread::{ThreadMetadata, ThreadStatus};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Preferences {
    pub completion: bool,
    pub permission: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            completion: true,
            permission: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Authorization {
    #[default]
    Unknown,
    NotDetermined,
    Requesting,
    Granted,
    Denied,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Failure {
    Preferences,
    Permission,
    Delivery,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Navigation {
    pub id: Uuid,
    pub thread_id: Uuid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub supported: bool,
    pub preferences: Preferences,
    pub authorization: Authorization,
    pub failure: Option<Failure>,
    pub confirmed_completions: HashMap<Uuid, Uuid>,
    pub navigation: Option<Navigation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Kind {
    Completion,
    Permission,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Notice {
    pub id: Uuid,
    pub thread_id: Uuid,
    pub kind: Kind,
    pub title: String,
}
impl Notice {
    pub fn identifier(&self) -> String {
        format!("atte.{}.{}", self.thread_id, self.id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Effect {
    Show(Notice),
    Remove(String),
    Badge(usize),
}

pub(super) struct Policy {
    pub snapshot: Snapshot,
    pub active: bool,
    pub viewed_thread: Option<Uuid>,
    pub korean: bool,
    pub ready: bool,
    pub stopped: bool,
    entries: HashMap<Uuid, ThreadMetadata>,
    notices: HashMap<(Uuid, Kind), Notice>,
    initialized: bool,
}

impl Policy {
    pub fn new(supported: bool, preferences: Preferences, failure: Option<Failure>) -> Self {
        Self {
            snapshot: Snapshot {
                supported,
                preferences,
                authorization: Authorization::Unknown,
                failure,
                confirmed_completions: HashMap::new(),
                navigation: None,
            },
            active: !supported,
            viewed_thread: None,
            korean: false,
            ready: false,
            stopped: false,
            entries: HashMap::new(),
            notices: HashMap::new(),
            initialized: false,
        }
    }

    pub fn observe(&mut self, entries: Vec<ThreadMetadata>, active_at_event: bool) -> Vec<Effect> {
        let mut effects = Vec::new();
        let ids: HashSet<_> = entries.iter().map(|entry| entry.id).collect();
        let removed: Vec<_> = self
            .entries
            .keys()
            .filter(|id| !ids.contains(id))
            .copied()
            .collect();
        for id in removed {
            self.remove_notice(id, Kind::Completion, &mut effects);
            self.remove_notice(id, Kind::Permission, &mut effects);
            self.snapshot.confirmed_completions.remove(&id);
            if self
                .snapshot
                .navigation
                .as_ref()
                .is_some_and(|nav| nav.thread_id == id)
            {
                self.snapshot.navigation = None;
            }
        }
        for entry in &entries {
            let previous = self.entries.get(&entry.id);
            let new_completion = entry.completed_turn_id.is_some()
                && previous.is_some_and(|old| old.completed_turn_id != entry.completed_turn_id);
            let waiting = entry.status == ThreadStatus::WaitingForInput;
            let new_permission =
                waiting && previous.is_some_and(|old| old.status != ThreadStatus::WaitingForInput);
            if !waiting {
                self.remove_notice(entry.id, Kind::Permission, &mut effects);
            }
            if self.initialized && self.snapshot.supported && !active_at_event && !self.stopped {
                if new_completion && entry.status == ThreadStatus::SessionReady {
                    self.add_notice(entry, Kind::Completion, &mut effects);
                }
                if new_permission {
                    self.add_notice(entry, Kind::Permission, &mut effects);
                }
            }
        }
        self.entries = entries.into_iter().map(|entry| (entry.id, entry)).collect();
        self.initialized = true;
        self.confirm_viewed(&mut effects);
        effects.push(Effect::Badge(self.badge_count()));
        effects
    }

    fn add_notice(&mut self, entry: &ThreadMetadata, kind: Kind, effects: &mut Vec<Effect>) {
        self.remove_notice(entry.id, kind, effects);
        let notice = Notice {
            id: Uuid::new_v4(),
            thread_id: entry.id,
            kind,
            title: entry.title.clone(),
        };
        if self.allowed(kind) {
            effects.push(Effect::Show(notice.clone()));
        }
        self.notices.insert((entry.id, kind), notice);
    }

    fn remove_notice(&mut self, id: Uuid, kind: Kind, effects: &mut Vec<Effect>) {
        if let Some(notice) = self.notices.remove(&(id, kind)) {
            effects.push(Effect::Remove(notice.identifier()));
        }
    }

    fn allowed(&self, kind: Kind) -> bool {
        self.snapshot.authorization == Authorization::Granted
            && match kind {
                Kind::Completion => self.snapshot.preferences.completion,
                Kind::Permission => self.snapshot.preferences.permission,
            }
    }

    pub fn valid(&self, notice: &Notice) -> bool {
        !self.stopped
            && !self.active
            && self.allowed(notice.kind)
            && self
                .notices
                .get(&(notice.thread_id, notice.kind))
                .is_some_and(|current| current.id == notice.id)
    }

    #[cfg(target_os = "macos")]
    pub fn notices_for_identifier(&self, identifier: &str) -> bool {
        self.notices
            .values()
            .any(|notice| notice.identifier() == identifier && self.valid(notice))
    }

    pub fn badge_count(&self) -> usize {
        self.notices
            .keys()
            .map(|(id, _)| id)
            .collect::<HashSet<_>>()
            .len()
    }

    fn confirm_viewed(&mut self, effects: &mut Vec<Effect>) {
        if !self.active {
            return;
        }
        if let Some(id) = self.viewed_thread {
            if let Some(turn) = self
                .entries
                .get(&id)
                .and_then(|entry| entry.completed_turn_id)
            {
                self.snapshot.confirmed_completions.insert(id, turn);
                self.remove_notice(id, Kind::Completion, effects);
            }
        }
    }

    pub fn context(&mut self, active: bool, thread: Option<Uuid>, korean: bool) -> Vec<Effect> {
        self.active = active;
        self.viewed_thread = thread;
        self.korean = korean;
        let mut effects = Vec::new();
        self.confirm_viewed(&mut effects);
        effects.push(Effect::Badge(self.badge_count()));
        effects
    }

    pub fn preferences(&mut self, preferences: Preferences) -> Vec<Effect> {
        self.snapshot.preferences = preferences;
        self.notices
            .values()
            .filter(|notice| !self.allowed(notice.kind))
            .map(|notice| Effect::Remove(notice.identifier()))
            .collect()
    }

    pub fn click(&mut self, identifier: &str) -> bool {
        let Some(notice) = self
            .notices
            .values()
            .find(|notice| notice.identifier() == identifier)
        else {
            return false;
        };
        if self.stopped || !self.entries.contains_key(&notice.thread_id) {
            return false;
        }
        self.snapshot.navigation = Some(Navigation {
            id: Uuid::new_v4(),
            thread_id: notice.thread_id,
        });
        true
    }

    pub fn acknowledge_navigation(&mut self, id: Uuid) {
        if self
            .snapshot
            .navigation
            .as_ref()
            .is_some_and(|nav| nav.id == id)
        {
            self.snapshot.navigation = None;
        }
    }

    pub fn stop(&mut self) {
        self.stopped = true;
        self.notices.clear();
        self.snapshot.navigation = None;
    }
}
