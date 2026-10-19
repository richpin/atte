//! App-owned desktop notifications; the main webview only reports its current page.
#[cfg(target_os = "macos")]
mod macos;
mod state;

use crate::thread::Threads;
pub(crate) use state::Preferences;
use state::{Authorization, Effect, Failure, Policy, Snapshot};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

pub(crate) struct Notifications {
    policy: Mutex<Policy>,
    subscribers: Mutex<Vec<mpsc::UnboundedSender<Snapshot>>>,
    activity: Arc<AtomicBool>,
    preference_path: PathBuf,
    preference_write: tokio::sync::Mutex<()>,
}

impl Notifications {
    fn subscribe(&self) -> Result<mpsc::UnboundedReceiver<Snapshot>, String> {
        // Serialize registration with updates so a snapshot cannot arrive after a newer patch.
        let policy = self
            .policy
            .lock()
            .map_err(|_| "Notification state unavailable")?;
        let mut subscribers = self
            .subscribers
            .lock()
            .map_err(|_| "Notification subscription unavailable")?;
        let (sender, receiver) = mpsc::unbounded_channel();
        let _ = sender.send(policy.snapshot.clone());
        subscribers.retain(|sender| !sender.is_closed());
        subscribers.push(sender);
        Ok(receiver)
    }
}

pub(crate) fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = app
        .path()
        .app_data_dir()?
        .join("notification-preferences.json");
    let (preferences, failure) = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(value) => (value, None),
            Err(error) => {
                eprintln!("notification preferences: {error}");
                (Preferences::default(), Some(Failure::Preferences))
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (Preferences::default(), None)
        }
        Err(error) => {
            eprintln!("notification preferences: {error}");
            (Preferences::default(), Some(Failure::Preferences))
        }
    };
    app.manage(Notifications {
        policy: Mutex::new(Policy::new(cfg!(target_os = "macos"), preferences, failure)),
        subscribers: Mutex::default(),
        activity: Arc::new(AtomicBool::new(!cfg!(target_os = "macos"))),
        preference_path: path,
        preference_write: tokio::sync::Mutex::new(()),
    });
    #[cfg(target_os = "macos")]
    if let Err(error) = macos::install(app) {
        fail(app, Failure::Unavailable, &error);
    }
    let activity = Arc::clone(&app.state::<Notifications>().activity);
    let mut updates = app
        .state::<Threads>()
        .subscribe_list_mapped(move |entries| {
            (entries.to_vec(), activity.load(Ordering::Acquire))
        })?;
    if let Ok((entries, active)) = updates.try_recv() {
        update(app, |policy| policy.observe(entries, active));
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some((entries, active)) = updates.recv().await {
            schedule(&handle, move |app| {
                update(app, |policy| policy.observe(entries, active));
            });
        }
    });
    Ok(())
}

// All policy transitions and native effects are serialized on the main thread.
fn update(app: &AppHandle, change: impl FnOnce(&mut Policy) -> Vec<Effect>) {
    let service = app.state::<Notifications>();
    let effects = {
        let Ok(mut policy) = service.policy.lock() else {
            return;
        };
        let before = policy.snapshot.clone();
        let effects = change(&mut policy);
        if policy.snapshot != before {
            if let Ok(mut subscribers) = service.subscribers.lock() {
                subscribers.retain(|sender| sender.send(policy.snapshot.clone()).is_ok());
            }
        }
        effects
    };
    #[cfg(target_os = "macos")]
    for effect in effects {
        match effect {
            Effect::Show(notice) => {
                let valid = service
                    .policy
                    .lock()
                    .is_ok_and(|policy| policy.valid(&notice));
                if valid && !macos::active(app) {
                    let korean = service.policy.lock().is_ok_and(|policy| policy.korean);
                    if let Err(error) = macos::show(app, &notice, korean) {
                        fail(app, Failure::Delivery, &error);
                    }
                }
            }
            Effect::Remove(identifier) => macos::remove(&identifier),
            Effect::Badge(count) => {
                if let Some(window) = app.get_window("main") {
                    if let Err(error) = window.set_badge_count((count > 0).then_some(count as i64))
                    {
                        fail(app, Failure::Delivery, &error.to_string());
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = effects;
}

fn schedule(app: &AppHandle, work: impl FnOnce(&AppHandle) + Send + 'static) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || work(&handle)) {
        eprintln!("notification main thread: {error}");
    }
}

async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(&AppHandle) -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(work(&handle));
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())
}

fn fail(app: &AppHandle, failure: Failure, detail: &str) {
    eprintln!("desktop notifications: {detail}");
    update(app, |policy| {
        policy.snapshot.failure = Some(failure);
        Vec::new()
    });
}

fn current_activity(app: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::active(app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        true
    }
}

pub(crate) fn refresh_activity(app: &AppHandle) {
    let Some(service) = app.try_state::<Notifications>() else {
        return;
    };
    let active = current_activity(app);
    service.activity.store(active, Ordering::Release);
    update(app, |policy| {
        policy.context(active, policy.viewed_thread, policy.korean)
    });
}

pub(crate) async fn shutdown(app: &AppHandle) {
    if app.try_state::<Notifications>().is_none() {
        return;
    }
    if let Err(error) = on_main(app, |app| {
        update(app, |policy| {
            policy.stop();
            vec![Effect::Badge(0)]
        });
        #[cfg(target_os = "macos")]
        macos::clear();
    })
    .await
    {
        eprintln!("notification shutdown: {error}");
    }
}

#[cfg(target_os = "macos")]
fn clicked(app: &AppHandle, identifier: String) {
    schedule(app, move |app| {
        // A deletion may already be committed while its list event is still queued.
        let current = match app.state::<Threads>().list() {
            Ok(entries) => entries,
            Err(error) => {
                fail(app, Failure::Unavailable, &error.to_string());
                return;
            }
        };
        let mut open = false;
        update(app, |policy| {
            open = policy.click(&identifier);
            if let Some(navigation) = &policy.snapshot.navigation {
                if !current.iter().any(|entry| entry.id == navigation.thread_id) {
                    policy.snapshot.navigation = None;
                    open = false;
                }
            }
            Vec::new()
        });
        if open {
            if let Err(error) = crate::lifecycle::reopen(app) {
                fail(app, Failure::Unavailable, &error.to_string());
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn authorization(app: &AppHandle, status: Authorization) {
    update(app, |policy| {
        policy.snapshot.authorization = status;
        if policy.snapshot.failure == Some(Failure::Permission) {
            policy.snapshot.failure = None;
        }
        Vec::new()
    });
}

pub(crate) fn subscribe(app: &AppHandle) -> Result<mpsc::UnboundedReceiver<Snapshot>, String> {
    app.state::<Notifications>().subscribe()
}

#[tauri::command]
pub(crate) async fn set_notification_context(
    app: AppHandle,
    thread_id: Option<Uuid>,
    locale: String,
    settings_visible: bool,
) -> Result<(), String> {
    on_main(&app, move |app| {
        let active = current_activity(app);
        app.state::<Notifications>()
            .activity
            .store(active, Ordering::Release);
        let mut first = false;
        update(app, |policy| {
            first = !policy.ready;
            policy.ready = true;
            policy.context(active, thread_id, locale == "ko")
        });
        #[cfg(target_os = "macos")]
        if first || settings_visible {
            macos::refresh_authorization(app, first);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (first, settings_visible);
    })
    .await
}

#[tauri::command]
pub(crate) async fn request_notification_permission(app: AppHandle) -> Result<(), String> {
    on_main(&app, |app| {
        #[cfg(target_os = "macos")]
        macos::refresh_authorization(app, true);
        #[cfg(not(target_os = "macos"))]
        let _ = app;
    })
    .await
}

fn save_preferences(path: &Path, preferences: Preferences) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Notification preferences directory unavailable")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    serde_json::to_writer(file.as_file_mut(), &preferences).map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    file.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn set_notification_preferences(
    app: AppHandle,
    preferences: Preferences,
) -> Result<(), String> {
    let service = app.state::<Notifications>();
    let _write = service.preference_write.lock().await;
    let path = service.preference_path.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || save_preferences(&path, preferences))
        .await
        .map_err(|error| error.to_string())?;
    on_main(&app, move |app| match saved {
        Ok(()) => {
            update(app, |policy| {
                if policy.snapshot.failure == Some(Failure::Preferences) {
                    policy.snapshot.failure = None;
                }
                policy.preferences(preferences)
            });
            Ok(())
        }
        Err(error) => {
            fail(app, Failure::Preferences, &error);
            Err(error)
        }
    })
    .await?
}

#[tauri::command]
pub(crate) async fn acknowledge_notification_navigation(
    app: AppHandle,
    id: Uuid,
) -> Result<(), String> {
    on_main(&app, move |app| {
        update(app, |policy| {
            policy.acknowledge_navigation(id);
            Vec::new()
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn open_notification_settings(app: AppHandle) -> Result<(), String> {
    on_main(&app, |app| {
        #[cfg(target_os = "macos")]
        {
            macos::open_settings(app)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = app;
            Ok(())
        }
    })
    .await?
}

#[tauri::command]
pub(crate) async fn subscribe_notifications(
    app: AppHandle,
    channel: Channel<Snapshot>,
    window: tauri::Webview,
    subscriptions: State<'_, crate::Subscriptions>,
) -> Result<Uuid, String> {
    crate::forward_subscription(
        subscribe(&app)?,
        channel,
        window,
        subscriptions.inner().clone(),
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests;
