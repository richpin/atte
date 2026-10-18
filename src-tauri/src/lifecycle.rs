//! Desktop window and deliberate application termination.
#[cfg(target_os = "macos")]
mod macos;

use crate::thread::Threads;
use std::{
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

#[derive(Default)]
pub(crate) struct Lifecycle {
    pending: AtomicBool,
    dirty_files: AtomicBool,
    finished: AtomicBool,
    stop: CancellationToken,
    operations: TaskTracker,
}

impl Lifecycle {
    /// Installation and removal retain ownership of file and process cleanup until done.
    pub(crate) async fn finish_before_exit<T, E: From<String>>(
        &self,
        operation: impl Future<Output = Result<T, E>>,
    ) -> Result<T, E> {
        self.operations
            .track_future(async {
                if self.stop.is_cancelled() {
                    return Err("앱을 종료하고 있습니다.".to_owned().into());
                }
                operation.await
            })
            .await
    }
    /// Tracks command-owned setup work so exit drops its process guards first.
    pub(crate) async fn operation<T>(
        &self,
        operation: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        self.operations
            .track_future(async {
                tokio::select! {
                    biased;
                    _ = self.stop.cancelled() => Err("앱을 종료하고 있습니다.".into()),
                    result = operation => result,
                }
            })
            .await
    }
}

pub(crate) fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    macos::install(app)?;
    Ok(())
}

pub(crate) fn on_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { api, code, .. } => {
            if app.state::<Lifecycle>().finished.load(Ordering::Acquire) {
                return;
            }
            api.prevent_exit();
            // A destroyed last window is not a request to quit on macOS.
            if code.is_some() || !cfg!(target_os = "macos") {
                request_quit(app);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } if !app.state::<Lifecycle>().stop.is_cancelled() => {
            if let Err(error) = reopen(app) {
                app.dialog()
                    .message(format!("창을 열 수 없습니다: {error}"))
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
        _ => {}
    }
}

#[cfg(target_os = "macos")]
fn reopen(app: &AppHandle) -> tauri::Result<()> {
    let window = match app.get_window("main") {
        Some(window) => window,
        None => {
            let Some(config) = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main")
            else {
                return Ok(());
            };
            tauri::WebviewWindowBuilder::from_config(app, config)?
                .build()?
                .as_ref()
                .window()
        }
    };
    window.unminimize()?;
    window.show()?;
    window.set_focus()
}

fn request_quit(app: &AppHandle) {
    let lifecycle = app.state::<Lifecycle>();
    if lifecycle.pending.swap(true, Ordering::AcqRel) {
        return;
    }
    if lifecycle.dirty_files.load(Ordering::Acquire) {
        // Dock quit must reveal the confirmation even after the window was hidden.
        if let Some(window) = app.get_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
        if app.emit_to("main", "files-quit-requested", ()).is_err() {
            lifecycle.pending.store(false, Ordering::Release);
        }
        return;
    }
    finish_quit(app);
}

fn finish_quit(app: &AppHandle) {
    let lifecycle = app.state::<Lifecycle>();
    app.state::<crate::workspace_files::WorkspaceFiles>()
        .clear();
    lifecycle.stop.cancel();
    lifecycle.operations.close();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let lifecycle = app.state::<Lifecycle>();
        let threads = app.state::<Threads>();
        tokio::join!(lifecycle.operations.wait(), threads.shutdown());
        lifecycle.finished.store(true, Ordering::Release);
        app.exit(0);
    });
}

#[tauri::command]
pub(crate) fn set_files_dirty(lifecycle: State<'_, Lifecycle>, dirty: bool) {
    lifecycle.dirty_files.store(dirty, Ordering::Release);
}

#[tauri::command]
pub(crate) fn resolve_quit(app: AppHandle, proceed: bool) {
    let lifecycle = app.state::<Lifecycle>();
    if !lifecycle.pending.load(Ordering::Acquire) {
        return;
    }
    if proceed {
        finish_quit(&app);
    } else {
        lifecycle.pending.store(false, Ordering::Release);
    }
}
