import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { type Channel, invoke } from "@tauri-apps/api/core";
import { I18nProvider } from "shared/i18n";
import { createMemorySettings, SettingsProvider } from "shared/settings";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Snapshot } from "../model/types";
import { McpsPage } from "./McpsPage";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = (_value: unknown) => {};
  },
}));
const snapshot: Snapshot = {
  servers: {
    remote: {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: { kind: "secret", value: "opaque-reference" } },
      enabled: true,
    },
  },
  issues: [],
  path: "/home/test/.atte/settings.json",
  error: null,
};
let receive: (snapshot: Snapshot) => void;
beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "subscribe_mcp") {
      const channel = (args as { channel: Channel<Snapshot> }).channel;
      receive = (value) => channel.onmessage(value);
      receive(structuredClone(snapshot));
      return "subscription";
    }
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function page() {
  return render(() => (
    <SettingsProvider settings={createMemorySettings({ locale: "en" })}>
      <I18nProvider>
        <McpsPage
          active
          projects={[{ name: "project", folder: "/tmp/project" }]}
        />
      </I18nProvider>
    </SettingsProvider>
  ));
}
it("toggles only the forwarding flag and waits for the subscription", async () => {
  page();
  const control = await screen.findByRole("switch", {
    name: "Forward server remote",
  });
  fireEvent.click(control);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("toggle_mcp", {
      target: { scope: "global" },
      name: "remote",
      enabled: false,
    }),
  );
  expect(control).toHaveProperty("checked", true);
  receive({
    ...snapshot,
    servers: { remote: { ...snapshot.servers.remote, enabled: false } },
  });
  await waitFor(() =>
    expect(screen.getByRole("switch")).toHaveProperty("checked", false),
  );
});

it("keeps saved credentials opaque while editing and can explicitly replace them", async () => {
  page();
  fireEvent.click(
    await screen.findByRole("button", { name: "Details / Edit" }),
  );
  const secret = await screen.findByLabelText("Secret value");
  expect(secret).toHaveProperty("value", "");
  expect(document.body.textContent).not.toContain("opaque-reference");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "save_mcp",
      expect.objectContaining({ name: "remote", secrets: {}, create: false }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Details / Edit" }));
  fireEvent.input(await screen.findByLabelText("Secret value"), {
    target: { value: "Bearer replacement" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "save_mcp",
      expect.objectContaining({
        secrets: { Authorization: "Bearer replacement" },
      }),
    ),
  );
});

it("keeps an existing secret when a replacement is typed and then cleared", async () => {
  page();
  fireEvent.click(
    await screen.findByRole("button", { name: "Details / Edit" }),
  );
  const secret = await screen.findByLabelText("Secret value");
  fireEvent.input(secret, { target: { value: "temporary replacement" } });
  fireEvent.input(secret, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "save_mcp",
      expect.objectContaining({ secrets: {} }),
    ),
  );
});
