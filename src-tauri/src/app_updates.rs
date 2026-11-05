//! Signed application updates; agent installations have a separate lifecycle.
use crate::lifecycle::{self, Lifecycle};
use serde::Serialize;
use std::time::Duration;
#[cfg(windows)]
use tauri::Manager;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Default)]
pub(crate) struct AppUpdates(Mutex<UpdateState>);

#[derive(Default)]
struct UpdateState {
    pending: Option<Update>,
    installed: bool,
    #[cfg(windows)]
    downloaded: Option<Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    supported: bool,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

fn configured(app: &AppHandle) -> bool {
    cfg!(any(target_os = "macos", windows))
        && !cfg!(debug_assertions)
        && app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|config| config.get("pubkey"))
            .and_then(|key| key.as_str())
            .is_some_and(|key| !key.trim().is_empty())
}

#[tauri::command]
pub(crate) async fn check_app_update(
    app: AppHandle,
    updates: State<'_, AppUpdates>,
) -> Result<UpdateInfo, String> {
    let mut state = updates.0.lock().await;
    let supported = configured(&app);
    if supported && !state.installed {
        state.pending = app
            .updater_builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| error.to_string())?
            .check()
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(UpdateInfo {
        supported,
        current_version: app.package_info().version.to_string(),
        version: state.pending.as_ref().map(|update| update.version.clone()),
        notes: state
            .pending
            .as_ref()
            .and_then(|update| update.body.clone()),
    })
}

#[tauri::command]
pub(crate) async fn install_app_update(
    app: AppHandle,
    updates: State<'_, AppUpdates>,
    lifecycle: State<'_, Lifecycle>,
    progress: Channel<DownloadProgress>,
) -> Result<(), String> {
    lifecycle
        .finish_before_exit(async {
            let mut state = updates.0.lock().await;
            if !configured(&app) || state.installed {
                return Err("Application update is unavailable.".to_owned());
            }
            let update = state.pending.as_ref().ok_or("Check for updates first.")?;
            let mut downloaded = 0;
            let bytes = update
                .download(
                    |chunk, total| {
                        downloaded += chunk as u64;
                        let _ = progress.send(DownloadProgress { downloaded, total });
                    },
                    || {},
                )
                .await
                .map_err(|error| error.to_string())?;
            // Windows installation exits the process. Retain verified bytes until
            // deliberate restart has confirmed dirty files and drained all work.
            #[cfg(windows)]
            {
                state.downloaded = Some(bytes);
            }
            #[cfg(not(windows))]
            {
                let update = update.clone();
                tauri::async_runtime::spawn_blocking(move || update.install(bytes))
                    .await
                    .map_err(|error| error.to_string())?
                    .map_err(|error| error.to_string())?;
            }
            state.installed = true;
            Ok(())
        })
        .await
}

#[tauri::command]
pub(crate) async fn restart_after_update(
    app: AppHandle,
    updates: State<'_, AppUpdates>,
) -> Result<(), String> {
    if !updates.0.lock().await.installed {
        return Err("Install an update before restarting.".to_owned());
    }
    lifecycle::request_restart(&app);
    Ok(())
}

/// Called only after lifecycle cleanup; successful Windows installation exits.
#[cfg(windows)]
pub(crate) async fn apply_before_restart(app: &AppHandle) -> Result<(), String> {
    let updates = app.state::<AppUpdates>();
    let mut state = updates.0.lock().await;
    let Some(bytes) = state.downloaded.take() else {
        return Ok(());
    };
    let update = state
        .pending
        .as_ref()
        .ok_or("Downloaded update is missing.")?
        .clone();
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}
