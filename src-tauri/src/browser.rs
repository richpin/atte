//! Native web tabs. Remote documents never receive application command access.
use serde::Serialize;
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
                    loading: native.isLoading(),
                    can_go_back: native.canGoBack(),
                    can_go_forward: native.canGoForward(),
                }
            };
            let _ = send.send(state);
        })
        .map_err(|error| error.to_string())?;
        receive.await.map_err(|_| "Web tab is unavailable".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(WebTabState {
            url: view.url().map_err(|error| error.to_string())?.to_string(),
            title: String::new(),
            loading: false,
            can_go_back: false,
            can_go_forward: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
