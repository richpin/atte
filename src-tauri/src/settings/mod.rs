//! Global user settings; the WebView observes an ordered snapshot subscription.
mod store;
use std::{sync::Mutex, time::Duration};
use store::{Legacy, Patch, Snapshot, Store};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use uuid::Uuid;

pub(crate) struct Settings(Mutex<Store>);

pub(crate) fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let store = Store::new(
        app.path().home_dir()?.join(".atte/settings.json"),
        app.path()
            .app_data_dir()?
            .join("notification-preferences.json"),
    );
    app.manage(Settings(Mutex::new(store)));
    Ok(())
}

pub(crate) fn observe_notifications(app: &AppHandle) -> Result<(), String> {
    let mut receiver = app
        .state::<Settings>()
        .0
        .lock()
        .map_err(|_| "Settings unavailable")?
        .subscribe();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(snapshot) = receiver.recv().await {
            crate::notifications::apply_preferences(
                &app,
                crate::notifications::Preferences {
                    completion: snapshot.values.notifications.completion,
                    permission: snapshot.values.notifications.permission,
                },
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn subscribe_settings(
    app: AppHandle,
    legacy: Legacy,
    channel: Channel<Snapshot>,
    window: tauri::Webview,
    subscriptions: State<'_, crate::Subscriptions>,
) -> Result<Uuid, String> {
    let handle = app.clone();
    let receiver = tauri::async_runtime::spawn_blocking(move || {
        let service = handle.state::<Settings>();
        let mut store = service.0.lock().map_err(|_| "Settings unavailable")?;
        store.initialize(legacy);
        Ok::<_, String>(store.subscribe())
    })
    .await
    .map_err(|error| error.to_string())??;
    crate::forward_subscription(receiver, channel, window, subscriptions.inner().clone())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn update_settings(app: AppHandle, patch: Patch) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Settings>()
            .0
            .lock()
            .map_err(|_| "Settings unavailable".to_string())?
            .patch(patch)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) fn watch(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let handle = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Ok(mut store) = handle.state::<Settings>().0.lock() {
                    if store.initialized() {
                        store.refresh();
                    }
                }
            })
            .await;
        }
    });
}
