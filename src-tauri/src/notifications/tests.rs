use super::{save_preferences, state::*};
use crate::thread::{ThreadMetadata, ThreadStatus};
use std::path::PathBuf;
use uuid::Uuid;

fn entry(id: u128, status: ThreadStatus, completed: Option<u128>) -> ThreadMetadata {
    ThreadMetadata {
        id: Uuid::from_u128(id),
        title: format!("Thread {id}"),
        working_folder: PathBuf::from("/project"),
        worktree: None,
        agent_id: "codex".into(),
        session_id: None,
        created_at: 1,
        updated_at: 1,
        last_prompt_at: None,
        status,
        failure: None,
        completed_turn_id: completed.map(Uuid::from_u128),
        interrupted: false,
    }
}
fn policy() -> Policy {
    let mut policy = Policy::new(true, Preferences::default(), None);
    policy.snapshot.authorization = Authorization::Granted;
    policy.observe(
        vec![
            entry(1, ThreadStatus::Running, None),
            entry(2, ThreadStatus::Running, None),
        ],
        false,
    );
    policy
}
fn shown(effects: &[Effect]) -> Vec<&Notice> {
    effects
        .iter()
        .filter_map(|effect| {
            if let Effect::Show(notice) = effect {
                Some(notice)
            } else {
                None
            }
        })
        .collect()
}

#[test]
fn initial_snapshots_do_not_replay_completion_or_approval() {
    let mut policy = Policy::new(true, Preferences::default(), None);
    let effects = policy.observe(
        vec![
            entry(1, ThreadStatus::SessionReady, Some(10)),
            entry(2, ThreadStatus::WaitingForInput, None),
        ],
        false,
    );
    assert!(shown(&effects).is_empty());
    assert_eq!(policy.badge_count(), 0);
}

#[test]
fn inactive_completion_notifies_once_despite_duplicate_or_renamed_snapshots() {
    let mut policy = policy();
    let mut completed = entry(1, ThreadStatus::SessionReady, Some(10));
    assert_eq!(
        shown(&policy.observe(vec![completed.clone()], false)).len(),
        1
    );
    completed.title = "Renamed".into();
    assert!(shown(&policy.observe(vec![completed], false)).is_empty());
    assert_eq!(policy.badge_count(), 1);
}

#[test]
fn foreground_events_are_not_replayed_when_leaving_the_app() {
    let mut policy = policy();
    policy.context(true, None, false);
    assert!(shown(&policy.observe(
        vec![
            entry(1, ThreadStatus::SessionReady, Some(10)),
            entry(2, ThreadStatus::WaitingForInput, None)
        ],
        true
    ))
    .is_empty());
    policy.context(false, None, false);
    assert_eq!(policy.badge_count(), 0);
}

#[test]
fn returning_only_confirms_the_open_thread_and_preserves_approval() {
    let mut policy = policy();
    policy.observe(
        vec![
            entry(1, ThreadStatus::SessionReady, Some(10)),
            entry(2, ThreadStatus::WaitingForInput, None),
        ],
        false,
    );
    policy.context(true, Some(Uuid::from_u128(2)), false);
    assert_eq!(policy.badge_count(), 2);
    let effects = policy.context(true, Some(Uuid::from_u128(1)), false);
    assert_eq!(
        policy
            .snapshot
            .confirmed_completions
            .get(&Uuid::from_u128(1)),
        Some(&Uuid::from_u128(10))
    );
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, Effect::Remove(_))));
    assert_eq!(policy.badge_count(), 1);
    policy.observe(
        vec![
            entry(1, ThreadStatus::SessionReady, Some(10)),
            entry(2, ThreadStatus::Running, None),
        ],
        true,
    );
    assert_eq!(policy.badge_count(), 0);
}

#[test]
fn background_open_thread_is_not_confirmed_until_app_activation() {
    let mut policy = policy();
    policy.context(false, Some(Uuid::from_u128(1)), false);
    policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(10))], false);
    assert!(policy.snapshot.confirmed_completions.is_empty());
    policy.context(true, Some(Uuid::from_u128(1)), false);
    assert_eq!(policy.badge_count(), 0);
}

#[test]
fn settings_page_does_not_confirm_completions() {
    let mut policy = policy();
    policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(10))], false);
    policy.context(true, None, false);
    assert!(policy.snapshot.confirmed_completions.is_empty());
    assert_eq!(policy.badge_count(), 1);
}

#[test]
fn approval_notifies_once_per_waiting_episode() {
    let mut policy = policy();
    let waiting = entry(1, ThreadStatus::WaitingForInput, None);
    assert_eq!(
        shown(&policy.observe(vec![waiting.clone()], false)).len(),
        1
    );
    assert!(shown(&policy.observe(vec![waiting.clone()], false)).is_empty());
    policy.observe(vec![entry(1, ThreadStatus::Running, None)], false);
    assert_eq!(shown(&policy.observe(vec![waiting], false)).len(), 1);
}

#[test]
fn completion_and_approval_count_the_same_thread_once() {
    let mut policy = policy();
    policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(10))], false);
    policy.observe(
        vec![entry(1, ThreadStatus::WaitingForInput, Some(10))],
        false,
    );
    assert_eq!(policy.badge_count(), 1);
    policy.context(true, Some(Uuid::from_u128(1)), false);
    assert_eq!(policy.badge_count(), 1);
}

#[test]
fn automatic_queued_continuation_only_notifies_at_the_end() {
    let mut policy = policy();
    assert!(
        shown(&policy.observe(vec![entry(1, ThreadStatus::Running, Some(10))], false)).is_empty()
    );
    assert_eq!(policy.badge_count(), 0);
    assert_eq!(
        shown(&policy.observe(
            vec![entry(1, ThreadStatus::WaitingForInput, Some(10))],
            false
        ))
        .len(),
        1
    );
    policy.observe(vec![entry(1, ThreadStatus::Running, Some(10))], false);
    assert_eq!(
        shown(&policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(11))], false)).len(),
        1
    );
}

#[test]
fn cancellation_and_connection_failure_clear_approval_without_completion() {
    for status in [
        ThreadStatus::Cancelling,
        ThreadStatus::Failed,
        ThreadStatus::Disconnected,
        ThreadStatus::SessionReady,
    ] {
        let mut policy = policy();
        policy.observe(vec![entry(1, ThreadStatus::WaitingForInput, None)], false);
        let effects = policy.observe(vec![entry(1, status, None)], false);
        assert!(shown(&effects).is_empty());
        assert!(effects
            .iter()
            .any(|effect| matches!(effect, Effect::Remove(_))));
        assert_eq!(policy.badge_count(), 0);
    }
}

#[test]
fn disabled_or_denied_notifications_still_count_badges_without_replaying() {
    let mut policy = policy();
    policy.snapshot.authorization = Authorization::Denied;
    assert!(
        shown(&policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(10))], false))
            .is_empty()
    );
    assert_eq!(policy.badge_count(), 1);
    policy.snapshot.authorization = Authorization::Granted;
    let removed = policy.preferences(Preferences {
        completion: false,
        permission: true,
    });
    assert_eq!(removed.len(), 1);
    assert!(shown(&policy.preferences(Preferences::default())).is_empty());
    assert_eq!(policy.badge_count(), 1);
}

#[test]
fn deleted_thread_clears_badge_confirmation_and_pending_navigation() {
    let mut policy = policy();
    let effects = policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(10))], false);
    let notice = shown(&effects)[0].clone();
    assert!(policy.click(&notice.identifier()));
    let removed = policy.observe(Vec::new(), false);
    assert!(removed.contains(&Effect::Remove(notice.identifier())));
    assert_eq!(policy.badge_count(), 0);
    assert!(policy.snapshot.navigation.is_none());
    assert!(!policy.valid(&notice));
    assert!(!policy.click(&notice.identifier()));
}

#[test]
fn stale_clicks_or_acknowledgements_cannot_replace_current_navigation() {
    let mut policy = policy();
    let first = policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(10))], false);
    let stale = shown(&first)[0].clone();
    let second = policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(11))], false);
    let current = shown(&second)[0].clone();
    assert!(!policy.valid(&stale));
    assert!(!policy.click(&stale.identifier()));
    assert!(policy.click(&current.identifier()));
    let navigation = policy.snapshot.navigation.clone().unwrap();
    policy.acknowledge_navigation(Uuid::new_v4());
    assert_eq!(policy.snapshot.navigation, Some(navigation.clone()));
    policy.acknowledge_navigation(navigation.id);
    assert!(policy.snapshot.navigation.is_none());
}

#[test]
fn events_use_source_activity_even_when_consumed_after_a_focus_change() {
    let mut policy = policy();
    // Published while active, consumed after leaving: do not create a background notice.
    policy.context(false, None, false);
    policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(10))], true);
    assert_eq!(policy.badge_count(), 0);
    // Published inactive, consumed after returning to Settings: retain badge, suppress delivery.
    policy.context(true, None, false);
    let effects = policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(11))], false);
    assert_eq!(policy.badge_count(), 1);
    assert!(shown(&effects).iter().all(|notice| !policy.valid(notice)));
    policy.context(true, Some(Uuid::from_u128(1)), false);
    assert_eq!(policy.badge_count(), 0);
}

#[test]
fn shutdown_invalidates_late_delivery_and_does_not_repopulate_badges() {
    let mut policy = policy();
    let effects = policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(10))], false);
    let notice = shown(&effects)[0].clone();
    policy.stop();
    assert!(!policy.valid(&notice));
    assert!(
        shown(&policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(11))], false))
            .is_empty()
    );
    assert_eq!(policy.badge_count(), 0);
}

#[test]
fn unsupported_platforms_keep_completion_confirmation_without_system_notifications() {
    let mut policy = Policy::new(false, Preferences::default(), None);
    policy.context(true, Some(Uuid::from_u128(1)), false);
    policy.observe(vec![entry(1, ThreadStatus::SessionReady, Some(10))], true);
    assert_eq!(
        policy
            .snapshot
            .confirmed_completions
            .get(&Uuid::from_u128(1)),
        Some(&Uuid::from_u128(10))
    );
    assert_eq!(policy.badge_count(), 0);
}

#[test]
fn preference_file_roundtrips_and_failed_writes_preserve_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("preferences.json");
    let preferences = Preferences {
        completion: false,
        permission: true,
    };
    save_preferences(&path, preferences).unwrap();
    let restored: Preferences = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(restored, preferences);
    let invalid = path.join("preferences.json");
    assert!(save_preferences(&invalid, Preferences::default()).is_err());
    assert_eq!(
        serde_json::from_slice::<Preferences>(&std::fs::read(path).unwrap()).unwrap(),
        preferences
    );
}
