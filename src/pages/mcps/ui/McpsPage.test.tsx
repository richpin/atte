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

it("checks a disabled server explicitly and never toggles or reconnects it", async () => {
  const base = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "check_mcp")
      return { status: "connected", tools: ["lookup"] };
    return base?.(command, args);
  });
  page();
  receive({
    ...snapshot,
    servers: { remote: { ...snapshot.servers.remote, enabled: false } },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Check connection" }),
  );
  expect(await screen.findByText("lookup")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith(
    "check_mcp",
    expect.objectContaining({
      target: { scope: "global" },
      name: "remote",
      id: expect.any(String),
    }),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([command]) =>
          command === "toggle_mcp" || command === "reconnect_thread",
      ),
  ).toBe(false);
});

it("cancels an isolated check when leaving the page and ignores its late result", async () => {
  const base = vi.mocked(invoke).getMockImplementation();
  let finish: ((result: unknown) => void) | undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "check_mcp")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return base?.(command, args);
  });
  const view = page();
  fireEvent.click(
    await screen.findByRole("button", { name: "Check connection" }),
  );
  await screen.findByRole("button", { name: "Cancel check" });
  view.unmount();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("cancel_mcp_check", {
      id: expect.any(String),
    }),
  );
  finish?.({ status: "connected", tools: ["stale-tool"] });
  await Promise.resolve();
  expect(screen.queryByText("stale-tool")).toBeNull();
});

it("reviews discovered sources, requires an explicit conflict choice and imports only selected entries", async () => {
  const base = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "discover_mcps")
      return [
        {
          tool: "Cursor",
          path: "/fixture/.cursor/mcp.json",
          status: "ready",
          error: null,
          candidates: [
            {
              id: "candidate-id",
              name: "remote",
              transport: "http",
              reason: null,
            },
            {
              id: null,
              name: "unsupported",
              transport: null,
              reason: "Unsupported transport",
            },
          ],
        },
      ];
    if (command === "import_mcps")
      return [{ id: "candidate-id", name: "remote", error: null }];
    return base?.(command, args);
  });
  page();
  fireEvent.click(
    await screen.findByRole("button", { name: "Import servers" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Discover global settings" }),
  );
  expect(await screen.findByText("/fixture/.cursor/mcp.json")).toBeTruthy();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([command]) => command === "import_mcps" || command === "check_mcp",
      ),
  ).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "remote · http" }));
  expect(
    screen.getByRole("button", { name: "Import selected" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Explicitly replace the existing server with this name",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("import_mcps", {
      target: { scope: "global" },
      selections: [{ id: "candidate-id", name: "remote", overwrite: true }],
    }),
  );
  expect(
    await screen.findByText(
      "Servers imported disabled. Review them before enabling.",
    ),
  ).toBeTruthy();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([command]) => command === "save_mcp" || command === "toggle_mcp",
      ),
  ).toBe(false);
});

it("signs in, cancels and signs out through the subscribed OAuth state", async () => {
  page();
  await screen.findByText("remote");
  const oauthSnapshot: Snapshot = {
    ...snapshot,
    servers: {
      remote: {
        type: "http",
        enabled: true,
        url: "https://example.com/mcp",
        headers: {},
        oauth: {},
      },
    },
    authentication: { remote: "required" },
  };
  receive(oauthSnapshot);
  await screen.findByText("Sign-in required");
  let finishLogin: (() => void) | undefined;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "login_mcp") {
      await new Promise<void>((resolve) => {
        finishLogin = resolve;
      });
    }
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("login_mcp", {
      target: { scope: "global" },
      name: "remote",
    }),
  );
  receive({ ...oauthSnapshot, authentication: { remote: "signingIn" } });
  await screen.findByText("Signing in…");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("cancel_mcp_login", {
      target: { scope: "global" },
      name: "remote",
    }),
  );
  finishLogin?.();
  receive({ ...oauthSnapshot, authentication: { remote: "authorized" } });
  await screen.findByText("Signed in");
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("logout_mcp", {
      target: { scope: "global" },
      name: "remote",
    }),
  );
  expect(screen.getByText("Signed in")).toBeTruthy();
  receive({
    ...oauthSnapshot,
    authentication: { remote: "reauthorizationRequired" },
  });
  await screen.findByText("Sign in again");
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
});
