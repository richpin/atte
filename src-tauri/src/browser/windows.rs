//! WebView2 COM objects stay inside Tauri's UI-thread callbacks.
use super::WebTabState;
use windows::core::{BOOL, PWSTR};

pub(super) fn navigate(
    platform: tauri::webview::PlatformWebview,
    action: &str,
) -> windows::core::Result<()> {
    // SAFETY: Tauri owns a live controller and invokes this on its UI thread.
    unsafe {
        let native = platform.controller().CoreWebView2()?;
        if action == "back" {
            native.GoBack()
        } else {
            native.GoForward()
        }
    }
}

pub(super) fn state(
    platform: tauri::webview::PlatformWebview,
    loading: bool,
) -> windows::core::Result<WebTabState> {
    // SAFETY: native objects never escape this UI-thread callback. WebView2's
    // allocated strings are immediately wrapped in CoTaskMem owners.
    unsafe {
        let native = platform.controller().CoreWebView2()?;
        let mut url = PWSTR::null();
        native.Source(&mut url)?;
        let url = webview2_com::CoTaskMemPWSTR::from(url).to_string();
        let mut title = PWSTR::null();
        native.DocumentTitle(&mut title)?;
        let title = webview2_com::CoTaskMemPWSTR::from(title).to_string();
        let mut back = BOOL::default();
        let mut forward = BOOL::default();
        native.CanGoBack(&mut back)?;
        native.CanGoForward(&mut forward)?;
        Ok(WebTabState {
            url,
            title,
            loading,
            favicon_url: None,
            can_go_back: back.as_bool(),
            can_go_forward: forward.as_bool(),
        })
    }
}

// Navigation IDs prevent an older cancelled request from clearing a newer load.
pub(super) fn install(
    platform: tauri::webview::PlatformWebview,
    loading: std::sync::Arc<std::sync::atomic::AtomicU64>,
    app: tauri::AppHandle,
) -> windows::core::Result<()> {
    use std::sync::atomic::Ordering;
    use webview2_com::{NavigationCompletedEventHandler, NavigationStartingEventHandler};
    // SAFETY: Tauri supplies the live controller on its UI thread. Event handlers
    // retain only thread-safe navigation state and are owned by the webview.
    unsafe {
        let native = platform.controller().CoreWebView2()?;
        let started = loading.clone();
        let mut token = 0;
        native.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut cancelled = BOOL::default();
                    args.Cancel(&mut cancelled)?;
                    if !cancelled.as_bool() {
                        let mut id = 0;
                        args.NavigationId(&mut id)?;
                        started.store(id, Ordering::Release);
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
        native.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut id = 0;
                    args.NavigationId(&mut id)?;
                    let current = loading.load(Ordering::Acquire);
                    if current == id {
                        let _ = loading.compare_exchange(
                            current,
                            0,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        );
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    crate::tab_menu::install_windows_shortcuts(platform, app)
}
