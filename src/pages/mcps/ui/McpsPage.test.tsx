import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { type Channel, invoke } from "@tauri-apps/api/core";
import userEvent from "@testing-library/user-event";
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
    if (command === "check_mcp") return { status: "noTools", tools: [] };
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function page(client = new QueryClient()) {
  return render(() => (
    <QueryClientProvider client={client}>
      <SettingsProvider settings={createMemorySettings({ locale: "en" })}>
        <I18nProvider>
          <McpsPage
            active
            projects={[{ name: "project", folder: "/tmp/project" }]}
          />
        </I18nProvider>
      </SettingsProvider>
    </QueryClientProvider>
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
  fireEvent.click(await screen.findByRole("button", { name: "remote" }));
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
  fireEvent.click(screen.getByRole("button", { name: "remote" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "remote" }));
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

it("refreshes a disabled server from the card without opening the editor or toggling it", async () => {
  const base = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "check_mcp")
      return { status: "connected", tools: ["lookup"] };
    return base?.(command, args);
  });
  page();
  await screen.findByText("lookup");
  receive({
    ...snapshot,
    servers: { remote: { ...snapshot.servers.remote, enabled: false } },
  });
  const refresh = await screen.findByRole("button", {
    name: "Check connection remote",
  });
  expect(refresh.textContent).toBe("");
  fireEvent.click(refresh);
  expect(await screen.findByText("lookup")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "check_mcp"),
  ).toHaveLength(2);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([command]) =>
          command === "toggle_mcp" || command === "reconnect_thread",
      ),
  ).toBe(false);
});

it("cancels an automatic check when leaving the page and ignores its late result", async () => {
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
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("check_mcp", {
      target: { scope: "global" },
      name: "remote",
      id: expect.any(String),
    }),
  );
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

const configuration = '{"mcpServers":{"new-server":{"command":"fixture"}}}';
const importSource = {
  tool: "Pasted configuration",
  path: "Clipboard input",
  status: "ready",
  error: null,
  candidates: [
    {
      id: "candidate-id",
      name: "new-server",
      transport: "stdio",
      reason: null,
    },
  ],
};
function mockImport() {
  const base = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "select_mcp_import") return configuration;
    if (command === "preview_mcp_import") return structuredClone(importSource);
    if (command === "import_mcps")
      return [{ id: "candidate-id", name: "new-server", error: null }];
    return base?.(command, args);
  });
}

it("loads a file into Configuration and imports its edited contents only on Save", async () => {
  mockImport();
  page();
  fireEvent.click(screen.getByRole("button", { name: "project" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Import servers" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByText("Scope")).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Review" })).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Discover global settings" }),
  ).toBeNull();
  const input = screen.getByRole("textbox", { name: "Configuration" });
  fireEvent.click(screen.getByRole("button", { name: "Choose" }));
  await waitFor(() => expect(input).toHaveProperty("value", configuration));
  expect(invoke).toHaveBeenCalledWith("select_mcp_import");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([command]) =>
          command === "preview_mcp_import" || command === "import_mcps",
      ),
  ).toBe(false);
  expect(within(dialog).queryByText("Selected file")).toBeNull();
  const edited = configuration.replace("fixture", "edited-fixture");
  fireEvent.input(input, { target: { value: edited } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("preview_mcp_import", {
      text: edited,
      format: "json",
    }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("import_mcps", {
      target: { scope: "project", folder: "/tmp/project" },
      selections: [
        { id: "candidate-id", name: "new-server", overwrite: false },
      ],
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([command]) =>
          command === "toggle_mcp" || command === "reconnect_thread",
      ),
  ).toBe(false);
});

it.each([
  { ...importSource, status: "error", error: "Invalid JSON", candidates: [] },
  {
    ...importSource,
    candidates: [
      {
        id: null,
        name: "bad",
        transport: null,
        reason: "Unsupported transport",
      },
    ],
  },
  { ...importSource, candidates: [] },
])(
  "shows validation errors below Configuration without importing or clearing input: %j",
  async (source) => {
    mockImport();
    const base = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(async (command, args) =>
      command === "preview_mcp_import" ? source : base?.(command, args),
    );
    page();
    fireEvent.click(
      await screen.findByRole("button", { name: "Import servers" }),
    );
    const input = await screen.findByLabelText("Configuration");
    fireEvent.input(input, { target: { value: configuration } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const error = await screen.findByRole("alert");
    expect(error.classList.contains("text-danger")).toBe(true);
    expect(input).toHaveProperty("value", configuration);
    expect(screen.queryByText("Selected file")).toBeNull();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "import_mcps"),
    ).toBe(false);
    fireEvent.input(input, { target: { value: `${configuration} ` } });
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it("preserves Configuration when file selection is cancelled or fails", async () => {
  mockImport();
  const base = vi.mocked(invoke).getMockImplementation();
  let fail = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "select_mcp_import") {
      if (fail) throw new Error("private path must not be shown");
      return null;
    }
    return base?.(command, args);
  });
  page();
  fireEvent.click(
    await screen.findByRole("button", { name: "Import servers" }),
  );
  const input = await screen.findByLabelText("Configuration");
  fireEvent.input(input, { target: { value: configuration } });
  fireEvent.click(screen.getByRole("button", { name: "Choose" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Choose" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(input).toHaveProperty("value", configuration);
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Choose" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Could not read",
  );
  expect(input).toHaveProperty("value", configuration);
  expect(document.body.textContent).not.toContain("private path");
});

it("rejects name conflicts and allows correcting Configuration before saving", async () => {
  mockImport();
  const base = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (
      command === "preview_mcp_import" &&
      (args as { text: string }).text === "conflict"
    )
      return {
        ...importSource,
        candidates: [{ ...importSource.candidates[0], name: "remote" }],
      };
    return base?.(command, args);
  });
  page();
  fireEvent.click(
    await screen.findByRole("button", { name: "Import servers" }),
  );
  const input = await screen.findByLabelText("Configuration");
  fireEvent.input(input, { target: { value: "conflict" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "remote: This name already exists",
  );
  expect(
    vi.mocked(invoke).mock.calls.some(([command]) => command === "import_mcps"),
  ).toBe(false);
  fireEvent.input(input, { target: { value: configuration } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("retries only failed servers after a partial import", async () => {
  mockImport();
  const base = vi.mocked(invoke).getMockImplementation();
  let attempt = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "preview_mcp_import")
      return {
        ...importSource,
        candidates: [
          ...importSource.candidates,
          { ...importSource.candidates[0], id: "second-id", name: "second" },
        ],
      };
    if (command === "import_mcps") {
      attempt++;
      return attempt === 1
        ? [
            { id: "candidate-id", name: "new-server", error: null },
            {
              id: "second-id",
              name: "second",
              error: "Credential store unavailable",
            },
          ]
        : [{ id: "second-id", name: "second", error: null }];
    }
    return base?.(command, args);
  });
  page();
  fireEvent.click(
    await screen.findByRole("button", { name: "Import servers" }),
  );
  fireEvent.input(await screen.findByLabelText("Configuration"), {
    target: { value: configuration },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "second: Credential store unavailable",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "import_mcps")[1][1],
  ).toEqual({
    target: { scope: "global" },
    selections: [{ id: "second-id", name: "second", overwrite: false }],
  });
});

it("signs in during connection checking, cancels login from the card and signs out from the editor footer", async () => {
  const base = vi.mocked(invoke).getMockImplementation();
  let authenticated = false;
  let finishLogin: (() => void) | undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "check_mcp")
      return authenticated
        ? { status: "connected", tools: ["oauth-tool"] }
        : { status: "authenticationRequired", tools: [] };
    if (command === "login_mcp") {
      await new Promise<void>((resolve) => {
        finishLogin = resolve;
      });
      authenticated = true;
      return;
    }
    return base?.(command, args);
  });
  page();
  await screen.findByText(
    "Authentication required. Refresh to sign in with OAuth, or update credentials in Edit server.",
  );
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
  const refresh = await screen.findByRole("button", {
    name: "Check connection remote",
  });
  expect(
    vi.mocked(invoke).mock.calls.some(([command]) => command === "login_mcp"),
  ).toBe(false);
  fireEvent.click(refresh);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("login_mcp", {
      target: { scope: "global" },
      name: "remote",
    }),
  );
  expect(await screen.findByText("Signing in…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel check remote" }));
  expect(invoke).toHaveBeenCalledWith("cancel_mcp_login", {
    target: { scope: "global" },
    name: "remote",
  });
  finishLogin?.();
  await waitFor(() => expect(authenticated).toBe(true));
  expect(screen.queryByText("oauth-tool")).toBeNull();
  authenticated = false;
  fireEvent.click(
    screen.getByRole("button", { name: "Check connection remote" }),
  );
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "login_mcp"),
    ).toHaveLength(2),
  );
  finishLogin?.();
  receive({ ...oauthSnapshot, authentication: { remote: "authorized" } });
  expect(await screen.findByText("oauth-tool")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "remote" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).queryByRole("button", { name: /Check connection|Sign in/ }),
  ).toBeNull();
  const signOut = within(dialog).getByRole("button", { name: "Sign out" });
  expect(
    within(dialog).getByRole("button", { name: "Uninstall" })
      .nextElementSibling,
  ).toBe(signOut);
  fireEvent.click(signOut);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("logout_mcp", {
      target: { scope: "global" },
      name: "remote",
    }),
  );
  await waitFor(() => expect(screen.queryByText("oauth-tool")).toBeNull());
  receive({ ...oauthSnapshot, authentication: { remote: "required" } });
  await Promise.resolve();
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "login_mcp"),
  ).toHaveLength(2);
  expect(within(dialog).queryByRole("button", { name: "Sign out" })).toBeNull();
});

it("opens editing from the card and uninstalls through the confirmation", async () => {
  page();
  await screen.findByRole("button", { name: "remote" });
  expect(screen.queryByRole("button", { name: "Check connection" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Uninstall" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "remote" }));
  expect(
    await screen.findByRole("dialog", { name: "Edit server" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
  const confirm = await screen.findByRole("alertdialog");
  fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("remove_mcp", {
      target: { scope: "global" },
      name: "remote",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("checks the saved configuration and updates tools on the card without listing them in the editor", async () => {
  const base = vi.mocked(invoke).getMockImplementation();
  let finish: ((result: unknown) => void) | undefined;
  const saved = {
    ...snapshot.servers.remote,
    url: "https://updated.example/mcp",
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "save_mcp") {
      receive({ ...snapshot, servers: { remote: saved } });
      return;
    }
    if (command === "check_mcp")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return base?.(command, args);
  });
  page();
  expect(screen.getByText("https://example.com/mcp")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "remote" }));
  fireEvent.input(screen.getByLabelText("URL"), {
    target: { value: saved.url },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByText("Checking connection…")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("check_mcp", {
    target: { scope: "global" },
    name: "remote",
    id: expect.any(String),
  });
  finish?.({ status: "connected", tools: ["updated-tool"] });
  expect(await screen.findByText("updated-tool")).toBeTruthy();
  receive({ ...snapshot, servers: { remote: { ...saved, enabled: false } } });
  expect(screen.getByText("updated-tool")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "remote" }));
  expect(
    within(await screen.findByRole("dialog")).queryByRole("list", {
      name: "Tools",
    }),
  ).toBeNull();
});

it("does not start another connection check when saving fails", async () => {
  const base = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "save_mcp") throw new Error("Save failed");
    return base?.(command, args);
  });
  page();
  fireEvent.click(await screen.findByRole("button", { name: "remote" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Error: Save failed",
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "check_mcp"),
  ).toHaveLength(1);
});

it("cancels the automatic check on scope change and ignores its late result", async () => {
  const base = vi.mocked(invoke).getMockImplementation();
  let finish: ((result: unknown) => void) | undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "check_mcp")
      return new Promise((resolve) => {
        if ((args as { target: { scope: string } }).target.scope === "global")
          finish = resolve;
      });
    return base?.(command, args);
  });
  page();
  fireEvent.click(await screen.findByRole("button", { name: "remote" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "project" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("cancel_mcp_check", {
      id: expect.any(String),
    }),
  );
  finish?.({ status: "connected", tools: ["old-scope-tool"] });
  await Promise.resolve();
  expect(screen.queryByText("old-scope-tool")).toBeNull();
});

it("caches tools across page visits and scopes, and discards changed configurations", async () => {
  const client = new QueryClient();
  const base = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "check_mcp")
      return {
        status: "connected",
        tools: [`${(args as { target: { scope: string } }).target.scope}-tool`],
      };
    return base?.(command, args);
  });
  const view = page(client);
  expect(await screen.findByText("global-tool")).toBeTruthy();
  receive(snapshot);
  fireEvent.click(screen.getByRole("button", { name: "project" }));
  expect(screen.queryByText("global-tool")).toBeNull();
  expect(await screen.findByText("project-tool")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Global" }));
  expect(screen.getByText("global-tool")).toBeTruthy();
  view.unmount();
  page(client);
  expect(await screen.findByText("global-tool")).toBeTruthy();
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "check_mcp"),
  ).toHaveLength(2);
  receive({
    ...snapshot,
    servers: {
      remote: {
        type: "http",
        enabled: true,
        headers: {},
        url: "https://changed.example/mcp",
      },
    },
  });
  expect(screen.queryByText("global-tool")).toBeNull();
  expect(await screen.findByText("global-tool")).toBeTruthy();
  receive(snapshot);
  expect(screen.queryByText("global-tool")).toBeNull();
  expect(await screen.findByText("global-tool")).toBeTruthy();
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "check_mcp"),
  ).toHaveLength(4);
});

it("uses the shared selects for transport and authentication", async () => {
  page();
  await userEvent.click(await screen.findByRole("button", { name: "remote" }));
  await userEvent.click(
    await screen.findByRole("button", { name: /^Transport/ }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "stdio" }));
  expect(await screen.findByLabelText("Command")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /^Transport/ }));
  await userEvent.click(
    await screen.findByRole("option", { name: "Streamable HTTP" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: /^Authentication/ }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "OAuth" }));
  expect(await screen.findByLabelText(/^Client ID/)).toBeTruthy();
});

it.each(["http", "stdio"])(
  "adds and deletes %s values through the icon buttons",
  async (transport) => {
    page();
    fireEvent.click(await screen.findByRole("button", { name: "remote" }));
    if (transport === "stdio") {
      await userEvent.click(screen.getByRole("button", { name: /^Transport/ }));
      await userEvent.click(screen.getByRole("option", { name: "stdio" }));
    }
    const group = screen.getByRole("group", {
      name: transport === "http" ? "HTTP headers" : "Environment variables",
    });
    const add = within(group).getByRole("button", { name: "Add value" });
    expect(add.textContent).toBe("");
    const before = within(group).queryAllByRole("button", {
      name: "Delete",
    }).length;
    fireEvent.click(add);
    const names = within(group).getAllByLabelText("Name");
    expect(names).toHaveLength(before + 1);
    const remove = within(group).getAllByRole("button", { name: "Delete" })[
      before
    ];
    expect(remove.textContent).toBe("");
    fireEvent.click(remove);
    expect(
      within(group).queryAllByRole("button", { name: "Delete" }),
    ).toHaveLength(before);
  },
);

it("checks disabled servers automatically and caches empty tool lists", async () => {
  const client = new QueryClient();
  const view = page(client);
  await screen.findByText(
    "Connected, but no tools are available. Check the server’s tool configuration.",
  );
  const disabled: Snapshot = {
    ...snapshot,
    servers: { remote: { ...snapshot.servers.remote, enabled: false } },
  };
  receive(disabled);
  view.unmount();
  page(client);
  await screen.findByText(
    "Connected, but no tools are available. Check the server’s tool configuration.",
  );
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "check_mcp"),
  ).toHaveLength(1);
  receive({
    ...disabled,
    servers: {
      ...disabled.servers,
      local: {
        type: "stdio",
        command: "fixture",
        args: [],
        env: {},
        enabled: false,
      },
    },
  });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("check_mcp", {
      target: { scope: "global" },
      name: "local",
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

it.each(["reject", "networkError"])(
  "does not loop after %s and retries uncached servers on the next visit",
  async (failure) => {
    const client = new QueryClient();
    const base = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "check_mcp") {
        if (failure === "reject") throw new Error("Check unavailable");
        return { status: "networkError", tools: [] };
      }
      return base?.(command, args);
    });
    const view = page(client);
    await waitFor(() =>
      expect(screen.queryByText("Checking connection…")).toBeNull(),
    );
    receive(snapshot);
    await Promise.resolve();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "check_mcp"),
    ).toHaveLength(1);
    view.unmount();
    page(client);
    await waitFor(() =>
      expect(screen.queryByText("Checking connection…")).toBeNull(),
    );
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "check_mcp"),
    ).toHaveLength(2);
  },
);

it("cancels a removed server check, ignores its result and checks a re-added server", async () => {
  const base = vi.mocked(invoke).getMockImplementation();
  let finish: ((result: unknown) => void) | undefined;
  let oldId: string | undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "check_mcp") {
      oldId = (args as { id: string }).id;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return base?.(command, args);
  });
  page();
  await waitFor(() => expect(oldId).toBeDefined());
  receive(snapshot);
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "check_mcp"),
  ).toHaveLength(1);
  receive({ ...snapshot, servers: {} });
  expect(invoke).toHaveBeenCalledWith("cancel_mcp_check", { id: oldId });
  finish?.({ status: "connected", tools: ["removed-tool"] });
  await Promise.resolve();
  receive(snapshot);
  expect(screen.queryByText("removed-tool")).toBeNull();
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "check_mcp"),
  ).toHaveLength(2);
});

it("shows a failed connection in the card’s tools area and retries with refresh", async () => {
  const base = vi.mocked(invoke).getMockImplementation();
  let fail = true;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "check_mcp") {
      if (fail) throw new Error("IPC error");
      return { status: "connected", tools: ["recovered-tool"] };
    }
    return base?.(command, args);
  });
  page();
  const message = await screen.findByText(
    "Connection check failed. Try again.",
  );
  expect(message.getAttribute("role")).toBe("status");
  expect(screen.queryByRole("alert")).toBeNull();
  fail = false;
  fireEvent.click(
    screen.getByRole("button", { name: "Check connection remote" }),
  );
  expect(await screen.findByText("recovered-tool")).toBeTruthy();
  expect(screen.queryByText("Connection check failed. Try again.")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows OAuth failure in the tools area without repeatedly signing in", async () => {
  const base = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "check_mcp")
      return { status: "authenticationRequired", tools: [] };
    if (command === "login_mcp") throw new Error("OAuth discovery unavailable");
    return base?.(command, args);
  });
  page();
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
  fireEvent.click(
    await screen.findByRole("button", { name: "Check connection remote" }),
  );
  const error = await screen.findByText("Error: OAuth discovery unavailable");
  expect(error.getAttribute("role")).toBe("status");
  receive(oauthSnapshot);
  await Promise.resolve();
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "login_mcp"),
  ).toHaveLength(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("cancels OAuth on page exit and ignores a late login completion", async () => {
  const base = vi.mocked(invoke).getMockImplementation();
  let finish: (() => void) | undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "check_mcp")
      return { status: "authenticationRequired", tools: [] };
    if (command === "login_mcp")
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    return base?.(command, args);
  });
  const view = page();
  receive({
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
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Check connection remote" }),
  );
  await screen.findByText("Signing in…");
  const checks = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "check_mcp").length;
  view.unmount();
  expect(invoke).toHaveBeenCalledWith("cancel_mcp_login", {
    target: { scope: "global" },
    name: "remote",
  });
  finish?.();
  await Promise.resolve();
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "check_mcp"),
  ).toHaveLength(checks);
});

it("never opens sign-in during automatic checks on entry, scope changes or revisits", async () => {
  const client = new QueryClient();
  const base = vi.mocked(invoke).getMockImplementation();
  const oauth: Snapshot = {
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
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "subscribe_mcp") {
      const channel = (args as { channel: Channel<Snapshot> }).channel;
      receive = (value) => channel.onmessage(value);
      receive(oauth);
      return "subscription";
    }
    if (command === "check_mcp")
      return { status: "authenticationRequired", tools: [] };
    return base?.(command, args);
  });
  const view = page(client);
  await screen.findByRole("button", { name: "Check connection remote" });
  receive(oauth);
  fireEvent.click(screen.getByRole("button", { name: "project" }));
  await screen.findByRole("button", { name: "Check connection remote" });
  view.unmount();
  page(client);
  await screen.findByRole("button", { name: "Check connection remote" });
  expect(
    vi.mocked(invoke).mock.calls.filter(([command]) => command === "check_mcp"),
  ).toHaveLength(3);
  expect(
    vi.mocked(invoke).mock.calls.some(([command]) => command === "login_mcp"),
  ).toBe(false);
});

it.each([false, true])(
  "allows sign-in after Save with an automatic check pending: %s",
  async (pending) => {
    const base = vi.mocked(invoke).getMockImplementation();
    const oauth: Snapshot = {
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
    let finish: ((result: unknown) => void) | undefined;
    let authorized = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "subscribe_mcp") {
        const channel = (args as { channel: Channel<Snapshot> }).channel;
        receive = (value) => channel.onmessage(value);
        receive(oauth);
        return "subscription";
      }
      if (command === "check_mcp") {
        if (authorized)
          return { status: "connected", tools: ["saved-oauth-tool"] };
        if (pending)
          return new Promise((resolve) => {
            finish = resolve;
          });
        return { status: "authenticationRequired", tools: [] };
      }
      if (command === "login_mcp") {
        authorized = true;
        return;
      }
      return base?.(command, args);
    });
    page();
    if (!pending)
      await screen.findByRole("button", { name: "Check connection remote" });
    fireEvent.click(await screen.findByRole("button", { name: "remote" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    finish?.({ status: "authenticationRequired", tools: [] });
    expect(await screen.findByText("saved-oauth-tool")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("login_mcp", {
      target: { scope: "global" },
      name: "remote",
    });
  },
);
