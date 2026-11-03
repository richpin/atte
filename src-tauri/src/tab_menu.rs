//! Native tab accelerators also work while a child webview has keyboard focus.
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Emitter, Manager,
};

const PREFIX: &str = "project-tab:";

pub fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
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
            ("new", "New Tab", "Cmd+T"),
            ("close", "Close Tab", "Cmd+W"),
            ("window", "Close Window", "Cmd+Shift+W"),
            ("next", "Next Tab", "Ctrl+Tab"),
            ("previous", "Previous Tab", "Ctrl+Shift+Tab"),
            ("next", "Next Tab", "Cmd+Shift+BracketRight"),
            ("previous", "Previous Tab", "Cmd+Shift+BracketLeft"),
        ] {
            submenu.append(&MenuItem::with_id(
                app,
                format!("{PREFIX}{action}:{accelerator}"),
                label,
                true,
                Some(accelerator),
            )?)?;
        }
        for number in 1..=9 {
            submenu.append(&MenuItem::with_id(
                app,
                format!("{PREFIX}tab:{number}"),
                format!("Select Tab {number}"),
                true,
                Some(format!("Cmd+{number}")),
            )?)?;
        }
    }
    Ok(menu)
}

pub fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let Some(action) = event.id().as_ref().strip_prefix(PREFIX) else {
        return;
    };
    if action.starts_with("window:") {
        if let Some(window) = app.get_window("main") {
            let _ = window.close();
        }
        return;
    }
    let command = if action.starts_with("tab:") {
        action.to_owned()
    } else {
        action.split(':').next().unwrap_or_default().to_owned()
    };
    let _ = app.emit_to("main", "project-tab-shortcut", command);
}
