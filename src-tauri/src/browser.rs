//! Native web tabs. Remote documents never receive application command access.
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use uuid::Uuid;

fn web_url(value: &str, app_url: Option<&tauri::Url>) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "Invalid web address".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.host_str() == Some("tauri.localhost")
        || app_url.is_some_and(|app| app.origin() == url.origin())
    {
        return Err("Only external HTTP and HTTPS addresses are supported".into());
    }
    Ok(url)
}

fn tab(app: &tauri::AppHandle, id: Uuid) -> Result<tauri::Webview, String> {
    app.get_webview(&format!("browser-{id}"))
        .ok_or_else(|| "Web tab is closed".into())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRequest {
    thread_id: Uuid,
    url: String,
}

#[tauri::command]
pub async fn create_web_tab(
    app: tauri::AppHandle,
    id: Uuid,
    thread_id: Uuid,
    url: String,
) -> Result<(), String> {
    let dev_url = app.config().build.dev_url.clone();
    let url = web_url(&url, dev_url.as_ref())?;
    if app.get_webview(&format!("browser-{id}")).is_some() {
        return Err("Web tab already exists".into());
    }
    let navigation_url = dev_url.clone();
    let popup_app = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(
        format!("browser-{id}"),
        tauri::WebviewUrl::External(url),
    )
    .on_navigation(move |url| web_url(url.as_str(), navigation_url.as_ref()).is_ok())
    .on_new_window(move |url, _| {
        if web_url(url.as_str(), dev_url.as_ref()).is_ok() {
            let _ = popup_app.emit_to(
                "main",
                "browser-open",
                OpenRequest {
                    thread_id,
                    url: url.to_string(),
                },
            );
        }
        tauri::webview::NewWindowResponse::Deny
    })
    .on_download(|_, _| false);
    let view = app
        .get_window("main")
        .ok_or("Application window is unavailable")?
        .add_child(
            builder,
            tauri::LogicalPosition::new(-10000, -10000),
            tauri::LogicalSize::new(1, 1),
        )
        .map_err(|error| error.to_string())?;
    if let Err(error) = view.hide() {
        let _ = view.close();
        return Err(error.to_string());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebTabState {
    url: String,
    title: String,
    favicon_url: Option<String>,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

#[tauri::command]
pub async fn web_tab_action(
    app: tauri::AppHandle,
    id: Uuid,
    action: String,
    url: Option<String>,
) -> Result<(), String> {
    let view = tab(&app, id)?;
    match action.as_str() {
        "navigate" => view
            .navigate(web_url(
                url.as_deref().ok_or("Missing web address")?,
                app.config().build.dev_url.as_ref(),
            )?)
            .map_err(|error| error.to_string()),
        "reload" => view.reload().map_err(|error| error.to_string()),
        "close" => view.close().map_err(|error| error.to_string()),
        "back" | "forward" => {
            #[cfg(target_os = "macos")]
            {
                view.with_webview(move |platform| {
                    // SAFETY: Tauri supplies the live WKWebView on the main thread;
                    // the borrowed pointer does not escape this callback.
                    let native = unsafe { &*platform.inner().cast::<objc2_web_kit::WKWebView>() };
                    unsafe {
                        if action == "back" {
                            native.goBack();
                        } else {
                            native.goForward();
                        }
                    }
                })
                .map_err(|error| error.to_string())
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("Native history navigation currently requires macOS".into())
            }
        }
        _ => Err("Unknown web tab action".into()),
    }
}

#[tauri::command]
pub async fn web_tab_state(app: tauri::AppHandle, id: Uuid) -> Result<WebTabState, String> {
    let view = tab(&app, id)?;
    let mut state = {
        #[cfg(target_os = "macos")]
        {
            let (send, receive) = tokio::sync::oneshot::channel();
            view.with_webview(move |platform| {
                // SAFETY: access is restricted to Tauri's main-thread callback and
                // only owned Rust values cross back into the async command.
                let native = unsafe { &*platform.inner().cast::<objc2_web_kit::WKWebView>() };
                let state = unsafe {
                    WebTabState {
                        url: native
                            .URL()
                            .and_then(|url| url.absoluteString())
                            .map(|url| url.to_string())
                            .unwrap_or_default(),
                        title: native
                            .title()
                            .map(|title| title.to_string())
                            .unwrap_or_default(),
                        favicon_url: None,
                        loading: native.isLoading(),
                        can_go_back: native.canGoBack(),
                        can_go_forward: native.canGoForward(),
                    }
                };
                let _ = send.send(state);
            })
            .map_err(|error| error.to_string())?;
            receive
                .await
                .map_err(|_| "Web tab is unavailable".to_owned())?
        }
        #[cfg(not(target_os = "macos"))]
        {
            WebTabState {
                url: view.url().map_err(|error| error.to_string())?.to_string(),
                title: String::new(),
                favicon_url: None,
                loading: false,
                can_go_back: false,
                can_go_forward: false,
            }
        }
    };
    let (send, mut receive) = tokio::sync::mpsc::channel(1);
    if view
        .eval_with_callback(include_str!("browser/favicon.ts"), move |value| {
            let _ = send.try_send(value);
        })
        .is_ok()
    {
        if let Ok(Some(value)) =
            tokio::time::timeout(std::time::Duration::from_millis(250), receive.recv()).await
        {
            state.favicon_url =
                favicon_url(&value, &state.url, app.config().build.dev_url.as_ref());
        }
    }
    Ok(state)
}

#[derive(Deserialize)]
struct FaviconMetadata {
    url: String,
    icon: String,
}

fn favicon_url(value: &str, page_url: &str, app_url: Option<&tauri::Url>) -> Option<String> {
    let metadata: FaviconMetadata = serde_json::from_str(value).ok()?;
    // Discard stale evaluations after navigation and never expose application URLs.
    if metadata.url != page_url || metadata.icon.len() > 65536 {
        return None;
    }
    if metadata.icon.starts_with("data:image/") {
        return Some(metadata.icon);
    }
    web_url(&metadata.icon, app_url)
        .ok()
        .map(|url| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_page_icons_and_rejects_stale_or_unsafe_metadata() {
        let app = tauri::Url::parse("http://localhost:1420").unwrap();
        let page = "https://example.com/";
        for icon in [
            "https://cdn.example.com/icon.svg",
            "data:image/png;base64,AA==",
        ] {
            let value = serde_json::json!({ "url": page, "icon": icon }).to_string();
            assert_eq!(favicon_url(&value, page, Some(&app)), Some(icon.to_owned()));
        }
        for icon in [
            "file:///tmp/icon",
            "javascript:alert(1)",
            "http://localhost:1420/icon",
            "https://tauri.localhost/icon",
        ] {
            let value = serde_json::json!({ "url": page, "icon": icon }).to_string();
            assert_eq!(favicon_url(&value, page, Some(&app)), None);
        }
        let stale = serde_json::json!({ "url": "https://other.example/", "icon": "https://example.com/icon" }).to_string();
        assert_eq!(favicon_url(&stale, page, Some(&app)), None);
        assert_eq!(favicon_url("null", page, Some(&app)), None);
        let oversized = serde_json::json!({ "url": page, "icon": format!("data:image/png,{}", "x".repeat(65536)) }).to_string();
        assert_eq!(favicon_url(&oversized, page, Some(&app)), None);
    }

    #[test]
    fn validates_external_web_addresses() {
        let app = tauri::Url::parse("http://localhost:1420").unwrap();
        for url in [
            "https://example.com",
            "http://localhost:3000",
            "http://127.0.0.1:8000",
        ] {
            assert!(web_url(url, Some(&app)).is_ok());
        }
        for url in [
            "file:///tmp/test",
            "javascript:alert(1)",
            "tauri://localhost",
            "https://tauri.localhost",
            "http://localhost:1420/path",
            "invalid",
        ] {
            assert!(web_url(url, Some(&app)).is_err());
        }
    }
}
