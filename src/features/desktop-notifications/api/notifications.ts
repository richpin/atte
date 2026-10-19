import { Channel, invoke } from "@tauri-apps/api/core";

export type NotificationPreferences = {
  completion: boolean;
  permission: boolean;
};
export type NotificationState = {
  supported: boolean;
  preferences: NotificationPreferences;
  authorization:
    | "unknown"
    | "notDetermined"
    | "requesting"
    | "granted"
    | "denied";
  failure: "preferences" | "permission" | "delivery" | "unavailable" | null;
  confirmedCompletions: Record<string, string>;
  navigation: { id: string; threadId: string } | null;
};

export function subscribeNotifications(
  receive: (state: NotificationState) => void,
) {
  const channel = new Channel<NotificationState>();
  channel.onmessage = receive;
  return invoke<string>("subscribe_notifications", { channel });
}

export function unsubscribeNotifications(subscription: string) {
  return invoke<void>("unsubscribe_thread", { subscription });
}

export function setNotificationContext(
  threadId: string | null,
  locale: string,
  settingsVisible: boolean,
) {
  return invoke<void>("set_notification_context", {
    threadId,
    locale,
    settingsVisible,
  });
}

export function saveNotificationPreferences(
  preferences: NotificationPreferences,
) {
  return invoke<void>("set_notification_preferences", { preferences });
}

export function acknowledgeNotificationNavigation(id: string) {
  return invoke<void>("acknowledge_notification_navigation", { id });
}

export function requestNotificationPermission() {
  return invoke<void>("request_notification_permission");
}

export function openNotificationSettings() {
  return invoke<void>("open_notification_settings");
}
