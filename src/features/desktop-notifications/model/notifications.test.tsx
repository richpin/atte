import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import { I18nProvider } from "shared/i18n";
import {
  initializeSettings,
  type SettingsModel,
  SettingsProvider,
  type SettingsSnapshot,
} from "shared/settings";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NotificationState } from "../api/notifications";
import { NotificationSettings } from "../ui/NotificationSettings";
import {
  createDesktopNotifications,
  type DesktopNotifications,
} from "./notifications";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
  Channel: class {
    onmessage = (_state: NotificationState) => {};
  },
}));

const initial = (): NotificationState => ({
  supported: true,
  preferences: { completion: true, permission: true },
  authorization: "granted",
  failure: null,
  confirmedCompletions: {},
  navigation: null,
});
let receive: (state: NotificationState) => void;
let model: DesktopNotifications;
let snapshot: NotificationState;
let settings: SettingsModel;
let settingsReceive: (snapshot: SettingsSnapshot) => void;
const settingsSnapshot = (): SettingsSnapshot => ({
  values: {
    theme: "system",
    locale: "en",
    notifications: { completion: true, permission: true },
  },
  error: null,
  migrated: true,
});

beforeEach(async () => {
  snapshot = initial();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "subscribe_settings") {
      settingsReceive = (
        args as { channel: { onmessage: typeof settingsReceive } }
      ).channel.onmessage;
      settingsReceive(settingsSnapshot());
      return "settings-subscription";
    }
    if (command === "subscribe_notifications") {
      receive = (args as { channel: { onmessage: typeof receive } }).channel
        .onmessage;
      receive(snapshot);
      return "notification-subscription";
    }
  });
  settings = await initializeSettings();
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
});

function mount() {
  render(() => (
    <SettingsProvider settings={settings}>
      <I18nProvider>
        <Settings />
      </I18nProvider>
    </SettingsProvider>
  ));
  function Settings() {
    model = createDesktopNotifications();
    return <NotificationSettings notifications={model} />;
  }
}

it("uses backend snapshots for confirmation without optimistic acknowledgements", async () => {
  mount();
  await waitFor(() => expect(model.loading()).toBe(false));
  await model.reportContext("thread-one", "en", false);
  expect(invoke).toHaveBeenCalledWith("set_notification_context", {
    threadId: "thread-one",
    locale: "en",
    settingsVisible: false,
  });
  expect(model.state()?.confirmedCompletions).toEqual({});
  receive({ ...snapshot, confirmedCompletions: { "thread-one": "turn-one" } });
  expect(model.state()?.confirmedCompletions).toEqual({
    "thread-one": "turn-one",
  });
  await model.reportContext(null, "en", true);
  expect(invoke).toHaveBeenLastCalledWith("set_notification_context", {
    threadId: null,
    locale: "en",
    settingsVisible: true,
  });
});

it("saves a partial notification setting and waits for the settings subscription", async () => {
  mount();
  const toggle = await screen.findByRole("switch", {
    name: "Response completion notifications",
  });
  await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("update_settings", {
      patch: { notifications: { completion: false } },
    }),
  );
  expect(model.preferences().completion).toBe(true);
  const next = settingsSnapshot();
  next.values.notifications.completion = false;
  settingsReceive(next);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("false"),
  );
});

it("keeps settings on save failure", async () => {
  mount();
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "update_settings"
      ? Promise.reject(new Error("disk full"))
      : (original?.(command, args) ?? Promise.resolve()),
  );
  await waitFor(() => expect(model.loading()).toBe(false));
  await model.save({ completion: false, permission: true });
  expect(model.preferences().completion).toBe(true);
  expect(model.error()).toBe(true);
});

it("opens system notification settings from the card heading", async () => {
  snapshot.authorization = "denied";
  mount();
  const heading = await screen.findByRole("heading", {
    name: "Desktop notifications",
  });
  const button = screen.getByRole("button", {
    name: "Open system notification settings",
  });
  expect(heading.parentElement?.contains(button)).toBe(true);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(button);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("open_notification_settings"),
  );
  expect(
    screen.queryByRole("button", { name: "Allow notifications" }),
  ).toBeNull();
});

it("releases a subscription that arrives after the UI is disposed", async () => {
  let finish!: (id: string) => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === "subscribe_notifications"
      ? new Promise<string>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(),
  );
  mount();
  cleanup();
  finish("late-subscription");
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("unsubscribe_thread", {
      subscription: "late-subscription",
    }),
  );
});

it("reconnects with a fresh snapshot and ignores the previous subscription", async () => {
  mount();
  await waitFor(() => expect(model.loading()).toBe(false));
  const old = receive;
  await model.retry();
  old({ ...snapshot, confirmedCompletions: { stale: "old" } });
  expect(model.state()?.confirmedCompletions).toEqual({});
  expect(invoke).toHaveBeenCalledWith("unsubscribe_thread", {
    subscription: "notification-subscription",
  });
});

it("disables system settings while the permission prompt is pending", async () => {
  snapshot.authorization = "requesting";
  mount();
  const button = await screen.findByRole("button", {
    name: "Open system notification settings",
  });
  expect(button).toHaveProperty("disabled", true);
  expect(screen.queryByRole("status")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Allow notifications" }),
  ).toBeNull();
});
