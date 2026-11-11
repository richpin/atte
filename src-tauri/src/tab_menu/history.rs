//! Custom editor histories coexist with AppKit's native responder chain.
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSView};
use tauri::{menu::MenuItem, AppHandle, Manager};

pub const PREFIX: &str = "edit-history:";

#[derive(Clone, Copy)]
pub enum Action {
    Undo,
    Redo,
}

impl Action {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "undo" => Some(Self::Undo),
            "redo" => Some(Self::Redo),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Undo => "undo",
            Self::Redo => "redo",
        }
    }
}

pub fn install(app: &AppHandle, menu: &tauri::menu::Menu<tauri::Wry>) -> tauri::Result<()> {
    for item in menu.items()? {
        let Some(submenu) = item.as_submenu() else {
            continue;
        };
        if submenu.text()? != "Edit" {
            continue;
        }
        for (index, entry) in submenu.items()?.into_iter().enumerate() {
            let Some(predefined) = entry.as_predefined_menuitem() else {
                continue;
            };
            let label = predefined.text()?;
            let (action, shortcut) = match label.replace('&', "").as_str() {
                "Undo" => (Action::Undo, "CmdOrCtrl+Z"),
                "Redo" => (Action::Redo, "CmdOrCtrl+Shift+Z"),
                _ => continue,
            };
            submenu.remove(predefined)?;
            submenu.insert(
                &MenuItem::with_id(
                    app,
                    format!("{PREFIX}{}", action.name()),
                    label,
                    true,
                    Some(shortcut),
                )?,
                index,
            )?;
        }
    }
    Ok(())
}

pub fn dispatch(app: &AppHandle, action: Action) {
    let Some(main) = app.get_webview("main") else {
        native(action);
        return;
    };
    let handle = app.clone();
    let target = main.clone();
    if main
        .with_webview(move |platform| {
            // SAFETY: Tauri lends a live WKWebView on the main thread. Neither
            // the view nor its responder references escape this callback.
            let view = unsafe { &*platform.inner().cast::<objc2_web_kit::WKWebView>() };
            let focused = view
                .window()
                .filter(|window| window.isKeyWindow())
                .and_then(|window| window.firstResponder())
                .is_some_and(|responder| {
                    responder
                        .downcast_ref::<NSView>()
                        .is_some_and(|focused| focused.isDescendantOf(view))
                });
            if !focused {
                native(action);
                return;
            }
            // A cancelable DOM event lets the owning editor consume the command.
            // Native fields (including editor search inputs) leave it unhandled.
            let script = format!(
                "(() => {{ let target = document.activeElement; \
                 while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement; \
                 return target ? target.dispatchEvent(new CustomEvent('atte-edit-history', \
                 {{ detail: '{}', bubbles: true, composed: true, cancelable: true }})) : true; }})()",
                action.name()
            );
            // Do not re-enter Tauri's webview dispatcher while with_webview
            // holds it. Evaluate from a task after the native callback returns.
            tauri::async_runtime::spawn(async move {
                let fallback = handle.clone();
                if target
                    .eval_with_callback(script, move |result| {
                        if result != "false" {
                            let _ = handle.run_on_main_thread(move || native(action));
                        }
                    })
                    .is_err()
                {
                    let _ = fallback.run_on_main_thread(move || native(action));
                }
            });
        })
        .is_err()
    {
        native(action);
    }
}

fn native(action: Action) {
    let Some(thread) = MainThreadMarker::new() else {
        return;
    };
    let selector = match action {
        Action::Undo => sel!(undo:),
        Action::Redo => sel!(redo:),
    };
    // SAFETY: This is the same selector/target used by AppKit's predefined
    // Undo/Redo items. A nil target selects the current native responder.
    unsafe {
        NSApplication::sharedApplication(thread).sendAction_to_from(selector, None, None);
    }
}
