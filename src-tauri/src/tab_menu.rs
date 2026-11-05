//! Native tab accelerators also work while a child webview has keyboard focus.
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Emitter, Manager,
};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use windows::install as install_windows_shortcuts;

const PREFIX: &str = "project-tab:";

pub fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    #[cfg(not(windows))]
    let menu = Menu::default(app)?;
    // WebView2 input is forwarded by the controller. Registering a Win32 HACCEL
    // would consume child-HWND messages before WebView2 can forward them.
    #[cfg(windows)]
    let menu = Menu::with_items(app, &[&tauri::menu::Submenu::new(app, "File", true)?])?;
    // A freshly created predefined item still contains its mnemonic marker;
    // items already inserted into the default menu do not.
    let close_text = PredefinedMenuItem::close_window(app, None)?
        .text()?
        .replace('&', "");

    for item in menu.items()? {
        let Some(submenu) = item.as_submenu() else {
            continue;
        };
        let title = submenu.text()?;
        if title != "File" && title != "Window" {
            continue;
        }
        for entry in submenu.items()? {
            if let Some(close) = entry.as_predefined_menuitem() {
                if close.text()?.replace('&', "") == close_text {
                    submenu.remove(close)?;
                }
            }
        }
        if title != "File" {
            continue;
        }

        for (action, label, accelerator) in [
            ("new", "New Tab", "CmdOrCtrl+T"),
            ("close", "Close Tab", "CmdOrCtrl+W"),
            ("window", "Close Window", "CmdOrCtrl+Shift+W"),
            ("next", "Next Tab", "Ctrl+Tab"),
            ("previous", "Previous Tab", "Ctrl+Shift+Tab"),
            ("next", "Next Tab", "CmdOrCtrl+Shift+BracketRight"),
            ("previous", "Previous Tab", "CmdOrCtrl+Shift+BracketLeft"),
        ] {
            #[cfg(windows)]
            let label = format!("{label}\t{}", accelerator.replace("CmdOrCtrl", "Ctrl"));
            #[cfg(windows)]
            let native_accelerator = None::<&str>;
            #[cfg(not(windows))]
            let native_accelerator = Some(accelerator);
            submenu.append(&MenuItem::with_id(
                app,
                format!("{PREFIX}{action}:{accelerator}"),
                label,
                true,
                native_accelerator,
            )?)?;
        }
        for number in 1..=9 {
            submenu.append(&MenuItem::with_id(
                app,
                format!("{PREFIX}tab:{number}"),
                if cfg!(windows) {
                    format!("Select Tab {number}\tCtrl+{number}")
                } else {
                    format!("Select Tab {number}")
                },
                true,
                if cfg!(windows) {
                    None
                } else {
                    Some(format!("CmdOrCtrl+{number}"))
                },
            )?)?;
        }
    }
    Ok(menu)
}

pub fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let Some(action) = event.id().as_ref().strip_prefix(PREFIX) else {
        return;
    };
    let command = if action.starts_with("tab:") {
        action.to_owned()
    } else {
        action.split(':').next().unwrap_or_default().to_owned()
    };
    dispatch(app, &command);
}

fn dispatch(app: &AppHandle, action: &str) {
    if action == "window" {
        if let Some(window) = app.get_window("main") {
            let _ = window.close();
        }
        return;
    }
    let _ = app.emit_to("main", "project-tab-shortcut", action);
}
