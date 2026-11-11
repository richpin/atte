use super::*;

#[test]
fn reopening_complete_settings_does_not_rewrite_the_users_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let content = r#"{"theme":"dark","locale":"ko","notifications":{"completion":false,"permission":true},"mcpServers":{},"custom":123}"#;
    std::fs::write(&path, content).unwrap();
    let mut store = Store::new(path.clone(), dir.path().join("previous.json"));
    store.initialize(Legacy::default());
    let snapshot = store.subscribe().try_recv().unwrap();
    assert_eq!(snapshot.values.theme, Theme::Dark);
    assert!(snapshot.error.is_none());
    assert_eq!(std::fs::read_to_string(path).unwrap(), content);
}

#[test]
fn migration_preserves_explicit_fields_and_only_fills_missing_preferences() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let old = dir.path().join("notification-preferences.json");
    std::fs::write(&path, r#"{"theme":"light","notifications":{"permission":true,"custom":"keep"},"mcpServers":{"demo":{"command":"test"}},"future":[1,2]}"#).unwrap();
    std::fs::write(&old, r#"{"completion":false,"permission":false}"#).unwrap();
    let mut store = Store::new(path.clone(), old.clone());
    store.initialize(Legacy {
        theme: Some(Theme::Dark),
        locale: Some(Locale::Ko),
    });
    let snapshot = store.subscribe().try_recv().unwrap();
    assert_eq!(
        snapshot.values,
        Values {
            theme: Theme::Light,
            locale: Locale::Ko,
            notifications: NotificationValues {
                completion: false,
                permission: true
            }
        }
    );
    assert!(snapshot.migrated);
    assert!(snapshot.error.is_none());
    assert!(!old.exists());
    let document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(document["notifications"]["custom"], "keep");
    assert_eq!(document["mcpServers"]["demo"]["command"], "test");
    assert_eq!(document["future"], json!([1, 2]));
    let mut reopened = Store::new(path, old);
    reopened.initialize(Legacy {
        theme: Some(Theme::System),
        locale: Some(Locale::En),
    });
    assert_eq!(
        reopened.subscribe().try_recv().unwrap().values,
        snapshot.values
    );
}

#[test]
fn failed_migration_keeps_sources_and_retries_without_losing_choices() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join(".atte");
    std::fs::write(&blocker, "not a directory").unwrap();
    let path = blocker.join("settings.json");
    let old = dir.path().join("notification-preferences.json");
    let previous = r#"{"completion":false,"permission":false}"#;
    std::fs::write(&old, previous).unwrap();
    let mut store = Store::new(path.clone(), old.clone());
    let legacy = Legacy {
        theme: Some(Theme::Dark),
        locale: Some(Locale::En),
    };
    store.initialize(legacy.clone());
    let failed = store.subscribe().try_recv().unwrap();
    assert!(failed.error.is_some());
    assert!(!failed.migrated);
    assert_eq!(std::fs::read_to_string(&old).unwrap(), previous);
    assert!(store
        .patch(Patch {
            theme: Some(Theme::Light),
            ..Patch::default()
        })
        .is_err());
    std::fs::remove_file(blocker).unwrap();
    store.initialize(legacy);
    let restored = store.subscribe().try_recv().unwrap();
    assert!(restored.error.is_none());
    assert!(restored.migrated);
    assert_eq!(restored.values.theme, Theme::Dark);
    assert_eq!(restored.values.locale, Locale::En);
    assert!(!restored.values.notifications.completion);
    assert!(!old.exists());
    assert!(path.exists());
}

#[test]
fn invalid_external_edits_keep_last_values_and_block_saves_until_reload_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let mut store = Store::new(path.clone(), dir.path().join("previous.json"));
    store.initialize(Legacy {
        theme: Some(Theme::Dark),
        locale: Some(Locale::Ko),
    });
    let mut changes = store.subscribe();
    let original = changes.try_recv().unwrap();
    for invalid in [
        "{broken",
        r#"{"theme":"sepia"}"#,
        r#"{"locale":null}"#,
        r#"{"notifications":{"completion":"yes"}}"#,
        r#"{"mcpServers":[]}"#,
        r#"{"notifications":[false,false]}"#,
    ] {
        std::fs::write(&path, invalid).unwrap();
        store.refresh();
        let failed = changes.try_recv().unwrap();
        assert_eq!(failed.values, original.values);
        assert!(failed.error.is_some());
        assert!(store
            .patch(Patch {
                theme: Some(Theme::Light),
                ..Patch::default()
            })
            .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), invalid);
    }
    std::fs::write(
        &path,
        r#"{"theme":"light","locale":"en","notifications":{"permission":false}}"#,
    )
    .unwrap();
    store.refresh();
    let recovered = changes.try_recv().unwrap();
    assert!(recovered.error.is_none());
    assert_eq!(recovered.values.theme, Theme::Light);
    assert_eq!(recovered.values.locale, Locale::En);
    assert!(!recovered.values.notifications.permission);
    store
        .patch(Patch {
            theme: Some(Theme::Dark),
            ..Patch::default()
        })
        .unwrap();
    assert_eq!(changes.try_recv().unwrap().values.theme, Theme::Dark);
}

#[test]
fn patches_read_latest_disk_contents_and_preserve_unrelated_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let mut store = Store::new(path.clone(), dir.path().join("previous.json"));
    store.initialize(Legacy::default());
    std::fs::write(&path, r#"{"locale":"ko","notifications":{"completion":false,"custom":42},"mcpServers":{"server":{"enabled":false}},"future":{"a":1}}"#).unwrap();
    store
        .patch(Patch {
            theme: Some(Theme::Dark),
            ..Patch::default()
        })
        .unwrap();
    store
        .patch(Patch {
            notifications: Some(NotificationPatch {
                permission: Some(false),
                ..NotificationPatch::default()
            }),
            ..Patch::default()
        })
        .unwrap();
    let snapshot = store.subscribe().try_recv().unwrap();
    assert_eq!(snapshot.values.locale, Locale::Ko);
    assert_eq!(snapshot.values.theme, Theme::Dark);
    assert!(!snapshot.values.notifications.completion);
    assert!(!snapshot.values.notifications.permission);
    let document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(document["notifications"]["custom"], 42);
    assert_eq!(document["mcpServers"]["server"]["enabled"], false);
    assert_eq!(document["future"], json!({"a":1}));
    let mut reopened = Store::new(path, dir.path().join("previous.json"));
    reopened.initialize(Legacy::default());
    assert_eq!(
        reopened.subscribe().try_recv().unwrap().values,
        snapshot.values
    );
}

#[test]
fn initial_invalid_json_is_preserved_and_repair_finishes_pending_migration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, "{broken").unwrap();
    let mut store = Store::new(path.clone(), dir.path().join("previous.json"));
    assert!(!store.initialized());
    store.initialize(Legacy {
        theme: Some(Theme::Dark),
        locale: Some(Locale::En),
    });
    assert!(store.initialized());
    let mut changes = store.subscribe();
    let failed = changes.try_recv().unwrap();
    assert_eq!(failed.values, Values::default());
    assert!(failed.error.is_some());
    assert!(!failed.migrated);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{broken");
    std::fs::write(&path, "{}").unwrap();
    store.refresh();
    let recovered = changes.try_recv().unwrap();
    assert!(recovered.error.is_none());
    assert!(recovered.migrated);
    assert_eq!(recovered.values.theme, Theme::Dark);
    assert_eq!(recovered.values.locale, Locale::En);
}

#[test]
fn simultaneous_partial_changes_are_serialized_and_restored_on_restart() {
    use std::sync::{Arc, Barrier, Mutex};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let mut store = Store::new(path.clone(), dir.path().join("previous.json"));
    store.initialize(Legacy::default());
    let store = Arc::new(Mutex::new(store));
    let barrier = Arc::new(Barrier::new(3));
    let patches = [
        Patch {
            theme: Some(Theme::Dark),
            ..Patch::default()
        },
        Patch {
            locale: Some(Locale::Ko),
            ..Patch::default()
        },
        Patch {
            notifications: Some(NotificationPatch {
                completion: Some(false),
                permission: Some(false),
            }),
            ..Patch::default()
        },
    ];
    let workers: Vec<_> = patches
        .into_iter()
        .map(|patch| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                store.lock().unwrap().patch(patch).unwrap();
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let mut reopened = Store::new(path, dir.path().join("previous.json"));
    reopened.initialize(Legacy::default());
    assert_eq!(
        reopened.subscribe().try_recv().unwrap().values,
        Values {
            theme: Theme::Dark,
            locale: Locale::Ko,
            notifications: NotificationValues {
                completion: false,
                permission: false
            },
        }
    );
}

#[test]
fn complete_settings_do_not_depend_on_an_unreadable_unused_legacy_source() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let old = dir.path().join("previous.json");
    std::fs::create_dir(&old).unwrap();
    std::fs::write(&path, r#"{"theme":"dark","locale":"ko","notifications":{"completion":false,"permission":false},"mcpServers":{}}"#).unwrap();
    let mut store = Store::new(path, old.clone());
    store.initialize(Legacy::default());
    let snapshot = store.subscribe().try_recv().unwrap();
    assert!(snapshot.error.is_none());
    assert_eq!(snapshot.values.theme, Theme::Dark);
    assert!(!snapshot.values.notifications.completion);
    assert!(old.is_dir());
}

#[test]
#[cfg(unix)]
fn a_readable_file_does_not_clear_a_write_failure_before_explicit_retry() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(
        dir.path().join("settings.json"),
        dir.path().join("previous.json"),
    );
    store.initialize(Legacy::default());
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
    let result = store.patch(Patch {
        theme: Some(Theme::Dark),
        ..Patch::default()
    });
    store.refresh();
    let failed = store.subscribe().try_recv().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert!(failed.error.is_some());
    assert_eq!(failed.values.theme, Theme::System);
    store.initialize(Legacy::default());
    assert!(store.subscribe().try_recv().unwrap().error.is_none());
    store
        .patch(Patch {
            theme: Some(Theme::Dark),
            ..Patch::default()
        })
        .unwrap();
    assert_eq!(
        store.subscribe().try_recv().unwrap().values.theme,
        Theme::Dark
    );
}
