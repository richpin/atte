import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import { I18nProvider } from "shared/i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NotificationState } from "../api/notifications";
import { NotificationSettings } from "../ui/NotificationSettings";
import {
  createDesktopNotifications,
  type DesktopNotifications,
} from "./notifications";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
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

beforeEach(() => {
  snapshot = initial();
  localStorage.setItem("atte.locale", "en");
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "subscribe_notifications") {
      receive = (args as { channel: { onmessage: typeof receive } }).channel
        .onmessage;
      receive(snapshot);
      return "notification-subscription";
    }
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
});

function mount() {
  render(() => (
    <I18nProvider>
      <Settings />
    </I18nProvider>
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

it("saves separate settings and waits for the subscription before displaying changes", async () => {
  mount();
  const toggle = await screen.findByRole("switch", {
    name: "Response completion notifications",
  });
  await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_notification_preferences", {
      preferences: { completion: false, permission: true },
    }),
  );
  expect(model.state()?.preferences.completion).toBe(true);
  receive({
    ...snapshot,
    preferences: { completion: false, permission: true },
  });
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("false"),
  );
});

it("keeps settings on save failure and exposes a persistent error", async () => {
  mount();
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "set_notification_preferences"
      ? Promise.reject(new Error("disk full"))
      : (original?.(command, args) ?? Promise.resolve()),
  );
  await waitFor(() => expect(model.loading()).toBe(false));
  await model.save({ completion: false, permission: true });
  expect(model.state()?.preferences.completion).toBe(true);
  expect((await screen.findByRole("alert")).textContent).toContain("failed");
});

it("shows OS denial and allows opening macOS notification settings", async () => {
  snapshot.authorization = "denied";
  mount();
  expect((await screen.findByRole("status")).textContent).toContain("blocked");
  fireEvent.click(
    screen.getByRole("button", { name: "Open macOS notification settings" }),
  );
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

it("keeps the system prompt pending instead of reporting a denial", async () => {
  snapshot.authorization = "requesting";
  mount();
  expect((await screen.findByRole("status")).textContent).toContain(
    "permission prompt",
  );
  expect(
    screen.getByRole("button", { name: "Open macOS notification settings" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.queryByRole("button", { name: "Allow notifications" }),
  ).toBeNull();
});
