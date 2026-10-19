//! The only layer that touches UserNotifications and AppKit.
use super::{
    state::{Authorization, Failure, Kind, Notice},
    Notifications,
};
use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send, rc::Retained, runtime::ProtocolObject, AnyThread, DeclaredClass,
    MainThreadMarker,
};
use objc2_app_kit::{
    NSApplication, NSApplicationDidBecomeActiveNotification,
    NSApplicationDidResignActiveNotification, NSWorkspace,
};
use objc2_foundation::{
    NSArray, NSBundle, NSError, NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol,
    NSString, NSURL,
};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use std::{cell::RefCell, ptr::NonNull};
use tauri::{AppHandle, Manager};

thread_local! {
    // AppKit objects and observer tokens never leave the main thread.
    static NATIVE: RefCell<Option<Native>> = const { RefCell::new(None) };
}
struct Native {
    center: Option<Retained<UNUserNotificationCenter>>,
    _delegate: Retained<NotificationDelegate>,
    _observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    authorization_generation: u64,
    requesting_authorization: bool,
    request_authorization_when_known: bool,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "AtteNotificationDelegate"]
    #[ivars = AppHandle]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}
    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn received(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            // Dismissal is not a read receipt. We register no dismissal action/category.
            let identifier = response.notification().request().identifier().to_string();
            super::clicked(self.ivars(), identifier);
            completion.call(());
        }

        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn presenting(
            &self,
            _center: &UNUserNotificationCenter,
            notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let identifier = notification.request().identifier().to_string();
            let app = self.ivars();
            let service = app.state::<Notifications>();
            let show = service.policy.lock().is_ok_and(|policy| {
                !policy.active && !policy.stopped && policy.notices_for_identifier(&identifier)
            });
            let options = if show {
                UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound
            } else {
                UNNotificationPresentationOptions::empty()
            };
            completion.call((options,));
        }
    }
);

impl NotificationDelegate {
    fn new(app: AppHandle) -> Retained<Self> {
        let this = Self::alloc().set_ivars(app);
        // SAFETY: NSObject initialization of our declared subclass with initialized ivars.
        unsafe { msg_send![super(this), init] }
    }
}

pub(super) fn install(app: &AppHandle) -> Result<(), String> {
    let main = MainThreadMarker::new().ok_or("Notification setup requires the main thread")?;
    let delegate = NotificationDelegate::new(app.clone());
    let notifications = NSNotificationCenter::defaultCenter();
    let mut observers = Vec::new();
    // SAFETY: these names are AppKit constants. The sendable blocks capture only AppHandle;
    // they dispatch back to the main thread before accessing AppKit or policy effects.
    for name in unsafe {
        [
            NSApplicationDidBecomeActiveNotification,
            NSApplicationDidResignActiveNotification,
        ]
    } {
        let handle = app.clone();
        let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
            if MainThreadMarker::new().is_some() {
                super::refresh_activity(&handle);
                refresh_authorization(&handle, false);
            } else {
                super::schedule(&handle, |app| {
                    super::refresh_activity(app);
                    refresh_authorization(app, false);
                });
            }
        });
        let observer = unsafe {
            notifications.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        observers.push(observer);
    }
    // UserNotifications raises an Objective-C exception without an application bundle.
    // `cargo tauri dev` must keep the app usable and explain this in Settings instead.
    let bundled = NSBundle::mainBundle().bundleIdentifier().is_some();
    let center = bundled.then(UNUserNotificationCenter::currentNotificationCenter);
    if let Some(center) = &center {
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        center.removeAllPendingNotificationRequests();
        center.removeAllDeliveredNotifications();
    }
    NATIVE.with(|native| {
        *native.borrow_mut() = Some(Native {
            center,
            _delegate: delegate,
            _observers: observers,
            authorization_generation: 0,
            requesting_authorization: false,
            request_authorization_when_known: false,
        })
    });
    let _ = NSApplication::sharedApplication(main);
    super::refresh_activity(app);
    if bundled {
        Ok(())
    } else {
        Err("System notifications require the bundled .app build".into())
    }
}

pub(super) fn active(app: &AppHandle) -> bool {
    let Some(main) = MainThreadMarker::new() else {
        return true;
    };
    NSApplication::sharedApplication(main).isActive()
        && app.get_window("main").is_some_and(|window| {
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
        })
}

pub(super) fn show(app: &AppHandle, notice: &Notice, korean: bool) -> Result<(), String> {
    NATIVE.with(|native| {
        let native = native.borrow();
        let center = native
            .as_ref()
            .and_then(|native| native.center.as_ref())
            .ok_or("System notifications unavailable")?;
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&notice.title));
        content.setBody(&NSString::from_str(match (notice.kind, korean) {
            (Kind::Completion, true) => "응답이 완료되었습니다.",
            (Kind::Permission, true) => "승인이 필요합니다.",
            (Kind::Completion, false) => "Response completed.",
            (Kind::Permission, false) => "Approval needed.",
        }));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        content.setThreadIdentifier(&NSString::from_str(&notice.thread_id.to_string()));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&notice.identifier()),
            &content,
            None,
        );
        let handle = app.clone();
        let notice = notice.clone();
        let completion = RcBlock::new(move |error: *mut NSError| {
            // SAFETY: NSError is valid for the duration of this system callback.
            let failure =
                unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
            let failed = failure.is_some();
            let notice = notice.clone();
            super::schedule(&handle, move |app| {
                if let Some(failure) = failure {
                    super::fail(app, Failure::Delivery, &failure);
                }
                if !failed {
                    super::update(app, |policy| {
                        if policy.snapshot.failure == Some(Failure::Delivery) {
                            policy.snapshot.failure = None;
                        }
                        Vec::new()
                    });
                }
                // Removal can race the asynchronous OS submission. Recheck after submission too.
                let valid = app
                    .state::<Notifications>()
                    .policy
                    .lock()
                    .is_ok_and(|policy| policy.valid(&notice));
                if failed || !valid || active(app) {
                    remove(&notice.identifier());
                }
            });
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
        Ok(())
    })
}

pub(super) fn remove(identifier: &str) {
    NATIVE.with(|native| {
        if let Some(center) = native
            .borrow()
            .as_ref()
            .and_then(|native| native.center.as_ref())
        {
            let ids = NSArray::from_retained_slice(&[NSString::from_str(identifier)]);
            center.removePendingNotificationRequestsWithIdentifiers(&ids);
            center.removeDeliveredNotificationsWithIdentifiers(&ids);
        }
    });
}

pub(super) fn clear() {
    NATIVE.with(|native| {
        if let Some(center) = native
            .borrow()
            .as_ref()
            .and_then(|native| native.center.as_ref())
        {
            center.removeAllPendingNotificationRequests();
            center.removeAllDeliveredNotifications();
        }
    });
}

pub(super) fn refresh_authorization(app: &AppHandle, request_if_needed: bool) {
    NATIVE.with(|native| {
        let mut native = native.borrow_mut();
        let Some(native) = native.as_mut() else {
            return;
        };
        let Some(center) = native.center.as_ref() else {
            return;
        };
        native.request_authorization_when_known |= request_if_needed;
        native.authorization_generation += 1;
        let generation = native.authorization_generation;
        let handle = app.clone();
        let completion = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: UserNotifications supplies a non-null settings object for this callback.
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            super::schedule(&handle, move |app| {
                let current = NATIVE.with(|native| {
                    native
                        .borrow()
                        .as_ref()
                        .is_some_and(|native| native.authorization_generation == generation)
                });
                if !current {
                    return;
                }
                let status = match status {
                    UNAuthorizationStatus::NotDetermined => Authorization::NotDetermined,
                    UNAuthorizationStatus::Denied => Authorization::Denied,
                    UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Provisional => {
                        Authorization::Granted
                    }
                    _ => Authorization::Unknown,
                };
                let requesting = NATIVE.with(|native| {
                    native
                        .borrow()
                        .as_ref()
                        .is_some_and(|native| native.requesting_authorization)
                });
                if requesting {
                    return;
                }
                super::authorization(app, status);
                // Activation may supersede the initial query; preserve the user's request
                // intent independently from which settings query finishes last.
                let should_request = NATIVE.with(|native| {
                    let mut native = native.borrow_mut();
                    let Some(native) = native.as_mut() else {
                        return false;
                    };
                    let pending = native.request_authorization_when_known;
                    if status != Authorization::Unknown {
                        native.request_authorization_when_known = false;
                    }
                    pending && status == Authorization::NotDetermined
                });
                if should_request {
                    request(app);
                }
            });
        });
        center.getNotificationSettingsWithCompletionHandler(&completion);
    });
}

fn request(app: &AppHandle) {
    NATIVE.with(|native| {
        let mut native = native.borrow_mut();
        let Some(native) = native.as_mut() else {
            return;
        };
        if native.requesting_authorization {
            return;
        }
        let Some(center) = native.center.as_ref() else {
            return;
        };
        native.requesting_authorization = true;
        native.authorization_generation += 1;
        super::authorization(app, Authorization::Requesting);
        let handle = app.clone();
        let completion =
            RcBlock::new(move |_granted: objc2::runtime::Bool, error: *mut NSError| {
                // SAFETY: NSError is valid for the duration of this system callback.
                let failure =
                    unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
                super::schedule(&handle, move |app| {
                    NATIVE.with(|native| {
                        if let Some(native) = native.borrow_mut().as_mut() {
                            native.requesting_authorization = false;
                        }
                    });
                    if let Some(failure) = failure {
                        super::update(app, |policy| {
                            policy.snapshot.authorization = Authorization::Unknown;
                            Vec::new()
                        });
                        super::fail(app, Failure::Permission, &failure);
                    } else {
                        refresh_authorization(app, false);
                    }
                });
            });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert
                | UNAuthorizationOptions::Sound
                | UNAuthorizationOptions::Badge,
            &completion,
        );
    });
}

pub(super) fn open_settings(_app: &AppHandle) -> Result<(), String> {
    let _main = MainThreadMarker::new().ok_or("Settings requires the main thread")?;
    let url = NSURL::URLWithString(&NSString::from_str(
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.atte.app",
    ))
    .ok_or("Notification Settings URL unavailable")?;
    if NSWorkspace::sharedWorkspace().openURL(&url) {
        Ok(())
    } else {
        Err("Could not open macOS notification settings".into())
    }
}
