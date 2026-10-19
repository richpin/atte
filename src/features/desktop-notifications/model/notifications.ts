import { createSignal, onCleanup, onMount } from "solid-js";
import {
  acknowledgeNotificationNavigation,
  type NotificationPreferences,
  type NotificationState,
  openNotificationSettings,
  requestNotificationPermission,
  saveNotificationPreferences,
  setNotificationContext,
  subscribeNotifications,
  unsubscribeNotifications,
} from "../api/notifications";

export function createDesktopNotifications() {
  const [state, setState] = createSignal<NotificationState>();
  const [subscriptionFailed, setSubscriptionFailed] = createSignal(false);
  const [operationFailed, setOperationFailed] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  let disposed = false;
  let subscription: string | undefined;
  let attempt = 0;
  let context: Parameters<typeof setNotificationContext> | undefined;

  async function connect() {
    const current = ++attempt;
    setLoading(true);
    setSubscriptionFailed(false);
    if (subscription) {
      void unsubscribeNotifications(subscription).catch(() => undefined);
      subscription = undefined;
    }
    try {
      const token = await subscribeNotifications((snapshot) => {
        if (!disposed && current === attempt) setState(snapshot);
      });
      if (disposed || current !== attempt) {
        void unsubscribeNotifications(token).catch(() => undefined);
      } else {
        subscription = token;
        const latestContext = context;
        if (latestContext)
          await run(() => setNotificationContext(...latestContext));
      }
    } catch {
      if (!disposed && current === attempt) setSubscriptionFailed(true);
    } finally {
      if (!disposed && current === attempt) setLoading(false);
    }
  }

  async function run(action: () => Promise<void>) {
    try {
      await action();
      if (!disposed) setOperationFailed(false);
      return true;
    } catch {
      if (!disposed) setOperationFailed(true);
      return false;
    }
  }

  async function save(preferences: NotificationPreferences) {
    if (saving()) return;
    setSaving(true);
    await run(() => saveNotificationPreferences(preferences));
    if (!disposed) setSaving(false);
  }

  onMount(() => void connect());
  onCleanup(() => {
    disposed = true;
    ++attempt;
    if (subscription)
      void unsubscribeNotifications(subscription).catch(() => undefined);
  });

  return {
    state,
    error: () => subscriptionFailed() || operationFailed(),
    loading,
    saving,
    retry: connect,
    save,
    reportContext: (
      threadId: string | null,
      locale: string,
      settingsVisible: boolean,
    ) => {
      context = [threadId, locale, settingsVisible];
      return run(() =>
        setNotificationContext(threadId, locale, settingsVisible),
      );
    },
    acknowledge: (id: string) =>
      run(() => acknowledgeNotificationNavigation(id)),
    requestPermission: () => run(requestNotificationPermission),
    openSettings: () => run(openNotificationSettings),
  };
}

export type DesktopNotifications = ReturnType<
  typeof createDesktopNotifications
>;
