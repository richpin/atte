import { cleanup, render, screen } from "@solidjs/testing-library";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { I18nProvider, useI18n } from "../i18n";
import { ThemeProvider, useTheme } from "../theme";
import {
  createMemorySettings,
  initializeSettings,
  type SettingsModel,
  SettingsProvider,
  type SettingsSnapshot,
} from "./settings";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  Channel: class {
    onmessage = (_snapshot: SettingsSnapshot) => {};
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme: vi.fn(async () => {}) }),
}));

const initial = (): SettingsSnapshot => ({
  values: {
    theme: "dark",
    locale: "en",
    notifications: { completion: false, permission: true },
  },
  error: null,
  migrated: true,
});
let receive: (snapshot: SettingsSnapshot) => void;
let model: SettingsModel | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  localStorage.clear();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "subscribe_settings") {
      receive = (args as { channel: { onmessage: typeof receive } }).channel
        .onmessage;
      receive(initial());
      return "settings-one";
    }
  });
});
afterEach(() => {
  cleanup();
  model?.dispose();
  model = undefined;
  vi.useRealTimers();
});

function Probe() {
  const { preference } = useTheme();
  const { locale } = useI18n();
  return (
    <p>
      {preference()}:{locale()}
    </p>
  );
}

test("waits for a delayed initial snapshot before constructing the first screen", async () => {
  localStorage.setItem("atte.theme", "light");
  localStorage.setItem("atte.locale", "ko");
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "subscribe_settings") {
      receive = (args as { channel: { onmessage: typeof receive } }).channel
        .onmessage;
      return "settings-one";
    }
  });
  let ready = false;
  const pending = initializeSettings().then((value) => {
    model = value;
    ready = true;
    return value;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  receive(initial());
  const settings = await pending;
  expect(invoke).toHaveBeenCalledWith("subscribe_settings", {
    legacy: { theme: "light", locale: "ko" },
    channel: expect.anything(),
  });
  render(() => (
    <SettingsProvider settings={settings}>
      <ThemeProvider>
        <I18nProvider>
          <Probe />
        </I18nProvider>
      </ThemeProvider>
    </SettingsProvider>
  ));
  expect(screen.getByText("dark:en")).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.lang).toBe("en");
  expect(localStorage.getItem("atte.theme")).toBeNull();
  expect(localStorage.getItem("atte.locale")).toBeNull();
});

test("publishes changes only through snapshots and never mirrors them to WebView storage", async () => {
  model = await initializeSettings();
  await model.update({ theme: "light" });
  expect(invoke).toHaveBeenCalledWith("update_settings", {
    patch: { theme: "light" },
  });
  expect(model.values().theme).toBe("dark");
  receive({ ...initial(), values: { ...initial().values, theme: "light" } });
  expect(model.values().theme).toBe("light");
  expect(localStorage.length).toBe(0);
});

test("preserves migration sources on failure and ignores an obsolete subscription after retry", async () => {
  localStorage.setItem("atte.theme", "dark");
  const implementation = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "subscribe_settings") {
      receive = (args as { channel: { onmessage: typeof receive } }).channel
        .onmessage;
      receive({ ...initial(), error: "invalid JSON", migrated: false });
      return "failed-settings";
    }
    return implementation?.(command, args);
  });
  model = await initializeSettings();
  expect(localStorage.getItem("atte.theme")).toBe("dark");
  await model.update({ theme: "light" });
  expect(invoke).not.toHaveBeenCalledWith("update_settings", expect.anything());
  const stale = receive;
  if (!implementation) throw new Error("Missing settings fixture");
  vi.mocked(invoke).mockImplementation(implementation);
  await model.retry();
  expect(model.error()).toBeNull();
  expect(localStorage.getItem("atte.theme")).toBeNull();
  stale({ ...initial(), error: "old error" });
  expect(model.error()).toBeNull();
  expect(invoke).toHaveBeenCalledWith("unsubscribe_thread", {
    subscription: "failed-settings",
  });
});

test("browser development uses memory and ignores legacy persisted values", async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  localStorage.setItem("atte.theme", "dark");
  model = await initializeSettings();
  expect(model.values().theme).toBe("system");
  await model.update({ locale: "ko", notifications: { completion: false } });
  expect(model.values()).toEqual({
    theme: "system",
    locale: "ko",
    notifications: { completion: false, permission: true },
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(localStorage.getItem("atte.theme")).toBe("dark");
  expect(createMemorySettings({ theme: "light" }).values().theme).toBe("light");
});

test("a late command failure cannot replace a newer recovery snapshot", async () => {
  model = await initializeSettings();
  let rejectWrite!: (reason: Error) => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === "update_settings"
      ? new Promise((_, reject) => {
          rejectWrite = reject;
        })
      : Promise.resolve(),
  );
  const write = model.update({ theme: "light" });
  receive({ ...initial(), error: "temporarily invalid" });
  receive(initial());
  rejectWrite(new Error("temporarily invalid"));
  await write;
  expect(model.error()).toBeNull();
});
