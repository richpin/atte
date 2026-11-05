//! WebView2 owns a child HWND, so forward app accelerators at the controller.
use tauri::AppHandle;
use webview2_com::{
    AcceleratorKeyPressedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    },
};

fn shortcut(key: u32, ctrl: bool, shift: bool, alt: bool, meta: bool) -> Option<String> {
    if !ctrl || alt || meta {
        return None;
    }
    match (key, shift) {
        (0x54, false) => Some("new".into()),
        (0x57, false) => Some("close".into()),
        (0x57, true) => Some("window".into()),
        (0x09, false) | (0xDD, true) => Some("next".into()),
        (0x09, true) | (0xDB, true) => Some("previous".into()),
        (0x31..=0x39, false) => Some(format!("tab:{}", key - 0x30)),
        _ => None,
    }
}

pub(crate) fn install(
    platform: tauri::webview::PlatformWebview,
    app: AppHandle,
) -> windows::core::Result<()> {
    // SAFETY: invoked only inside Tauri's UI-thread callback; the controller owns
    // the event handler until it is closed. No remote page gets app IPC access.
    unsafe {
        let mut token = 0;
        platform.controller().add_AcceleratorKeyPressed(
            &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                args.KeyEventKind(&mut kind)?;
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                    && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
                {
                    return Ok(());
                }
                let mut key = 0;
                args.VirtualKey(&mut key)?;
                let pressed =
                    |key| windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyState(key) < 0;
                if let Some(action) = shortcut(
                    key,
                    pressed(0x11),
                    pressed(0x10),
                    pressed(0x12),
                    pressed(0x5B) || pressed(0x5C),
                ) {
                    args.SetHandled(true)?;
                    let app = app.clone();
                    // Leave WebView2's synchronous input callback before operating
                    // other webviews or closing the window.
                    tauri::async_runtime::spawn(async move {
                        super::dispatch(&app, &action);
                    });
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::shortcut;
    #[test]
    fn maps_windows_tab_accelerators_without_stealing_other_editing_keys() {
        for (key, shift, expected) in [
            (0x54, false, "new"),
            (0x57, false, "close"),
            (0x57, true, "window"),
            (9, false, "next"),
            (9, true, "previous"),
            (0x39, false, "tab:9"),
        ] {
            assert_eq!(
                shortcut(key, true, shift, false, false).as_deref(),
                Some(expected)
            );
        }
        assert_eq!(shortcut(0x53, true, false, false, false), None);
        assert_eq!(shortcut(0x54, true, false, true, false), None);
        assert_eq!(shortcut(0x54, false, false, false, false), None);
    }
}
