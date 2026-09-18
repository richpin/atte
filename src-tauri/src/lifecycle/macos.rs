//! Bridge AppKit's quit action (including Dock quit) to managed shutdown.
use objc2::{
    runtime::{AnyObject, Imp, Sel},
    sel, MainThreadMarker,
};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use std::sync::OnceLock;
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();

pub(super) fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let main = MainThreadMarker::new().ok_or("AppKit setup requires the main thread")?;
    let application = NSApplication::sharedApplication(main);
    let delegate = application
        .delegate()
        .ok_or("Missing application delegate")?;
    let object: &AnyObject = (*delegate).as_ref();
    let class = object.class();
    let selector = sel!(applicationShouldTerminate:);
    if class.instance_method(selector).is_some() {
        return Err("The application delegate already handles termination".into());
    }
    APP.set(app.clone())
        .map_err(|_| "Termination handler already installed")?;
    // SAFETY: the existing Tao delegate remains installed. Only its missing optional
    // AppKit method is added, with NSUInteger return and (id, SEL, id) arguments.
    // Tauri 2.11/Tao 0.35 do not expose this callback (tauri-apps/tauri#12978).
    let added = unsafe {
        objc2::ffi::class_addMethod(
            (class as *const objc2::runtime::AnyClass).cast_mut(),
            selector,
            std::mem::transmute::<
                unsafe extern "C-unwind" fn(
                    &AnyObject,
                    Sel,
                    &NSApplication,
                ) -> NSApplicationTerminateReply,
                Imp,
            >(should_terminate),
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        return Err("Could not install the application termination handler".into());
    }
    // Refresh AppKit's optional delegate-method cache without replacing Tao's delegate.
    application.setDelegate(Some(&delegate));
    Ok(())
}

unsafe extern "C-unwind" fn should_terminate(
    _delegate: &AnyObject,
    _selector: Sel,
    _sender: &NSApplication,
) -> NSApplicationTerminateReply {
    if let Some(app) = APP.get() {
        let app = app.clone();
        // Return to AppKit before cleanup can request another exit.
        tauri::async_runtime::spawn(async move {
            super::request_quit(&app);
        });
    }
    // Our asynchronous cleanup ends via AppHandle::exit without a confirmation dialog.
    NSApplicationTerminateReply::TerminateCancel
}
