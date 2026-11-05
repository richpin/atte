//! Installed desktop identity and native Windows toast notifications.
use super::state::{Authorization, Kind, Notice};
use std::{cell::RefCell, collections::HashMap};
use tauri::{AppHandle, Manager};
use windows::{
    core::{IInspectable, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager},
};

// NSIS registers this identity on Atte's Start Menu shortcut. Toasts require
// installation; running the cross-built executable by itself is insufficient.
const APP_ID: &str = "com.atte.desktop";
thread_local! {
    static TOASTS: RefCell<HashMap<String, ToastNotification>> = RefCell::new(HashMap::new());
}

pub(super) fn active(app: &AppHandle) -> bool {
    app.get_window("main").is_some_and(|window| {
        // Child WebView2 controls can own keyboard focus while their top-level
        // Atte window remains the foreground application.
        window.hwnd().is_ok_and(|hwnd| {
            // SAFETY: querying the foreground HWND does not transfer ownership.
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() == hwnd.0 }
        }) && !window.is_minimized().unwrap_or(true)
    })
}

pub(super) fn install(_app: &AppHandle) -> Result<(), String> {
    // WinRT is initialized by Tauri on the UI thread.
    clear();
    Ok(())
}

pub(super) fn refresh_authorization(app: &AppHandle, _request: bool) {
    match ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
        .and_then(|notifier| notifier.Setting())
    {
        Ok(setting) => super::authorization(
            app,
            if setting == NotificationSetting::Enabled {
                Authorization::Granted
            } else {
                Authorization::Denied
            },
        ),
        Err(error) => super::fail(app, super::Failure::Permission, &error.to_string()),
    }
}

pub(super) fn show(app: &AppHandle, notice: &Notice, korean: bool) -> Result<(), String> {
    show_native(app, notice, korean).map_err(|error| error.to_string())
}
fn show_native(app: &AppHandle, notice: &Notice, korean: bool) -> windows::core::Result<()> {
    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(
        "<toast><visual><binding template='ToastGeneric'><text/><text/></binding></visual></toast>",
    ))?;
    // DOM text nodes preserve arbitrary thread titles without XML interpolation.
    document
        .SelectSingleNode(&HSTRING::from("//text[1]"))?
        .AppendChild(&document.CreateTextNode(&HSTRING::from(&notice.title))?)?;
    let body = match (notice.kind, korean) {
        (Kind::Completion, true) => "작업이 완료되었습니다.",
        (Kind::Completion, false) => "Work completed.",
        (Kind::Permission, true) => "응답이 필요합니다.",
        (Kind::Permission, false) => "Your response is needed.",
    };
    document
        .SelectSingleNode(&HSTRING::from("//text[2]"))?
        .AppendChild(&document.CreateTextNode(&HSTRING::from(body))?)?;
    let toast = ToastNotification::CreateToastNotification(&document)?;
    // Windows limits toast tags to 64 characters. The policy identifier is longer;
    // the random notice UUID is sufficient to distinguish notices within Atte.
    toast.SetTag(&HSTRING::from(notice.id.simple().to_string()))?;
    toast.SetGroup(&HSTRING::from("atte"))?;
    let identifier = notice.identifier();
    let clicked = identifier.clone();
    let handle = app.clone();
    toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
        move |_, _| {
            super::clicked(&handle, clicked.clone());
            Ok(())
        },
    ))?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))?.Show(&toast)?;
    TOASTS.with(|toasts| toasts.borrow_mut().insert(identifier, toast));
    Ok(())
}

pub(super) fn remove(identifier: &str) {
    TOASTS.with(|toasts| {
        if let Some(toast) = toasts.borrow_mut().remove(identifier) {
            let result =
                ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
                    .and_then(|notifier| notifier.Hide(&toast))
                    .and_then(|_| {
                        ToastNotificationManager::History()?.RemoveGroupedTagWithId(
                            &toast.Tag()?,
                            &HSTRING::from("atte"),
                            &HSTRING::from(APP_ID),
                        )
                    });
            if let Err(error) = result {
                eprintln!("remove toast: {error}");
            }
        }
    });
}

pub(super) fn clear() {
    if let Err(error) = ToastNotificationManager::History()
        .and_then(|history| history.ClearWithId(&HSTRING::from(APP_ID)))
    {
        eprintln!("clear toasts: {error}");
    }
    TOASTS.with(|toasts| toasts.borrow_mut().clear());
}

pub(super) fn badge(app: &AppHandle, count: usize) {
    if let Some(window) = app.get_window("main") {
        let attention =
            (count > 0 && !active(app)).then_some(tauri::UserAttentionType::Informational);
        if let Err(error) = window.request_user_attention(attention) {
            super::fail(app, super::Failure::Delivery, &error.to_string());
        }
    }
}

pub(super) fn open_settings(_app: &AppHandle) -> Result<(), String> {
    tauri_plugin_opener::open_url("ms-settings:notifications", None::<&str>)
        .map_err(|error| error.to_string())
}
