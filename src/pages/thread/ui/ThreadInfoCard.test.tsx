import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { I18nProvider } from "shared/i18n";
import { createMemorySettings, SettingsProvider } from "shared/settings";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ContextUsage, Thread } from "../model/types";
import { ThreadInfoCard } from "./ThreadInfoCard";

let settings = createMemorySettings();
beforeEach(() => {
  settings = createMemorySettings();
});

beforeEach(
  () =>
    (settings = createMemorySettings({ ...settings.values(), locale: "en" })),
);
afterEach(cleanup);

it("reacts to replacement and compaction with exact accessible usage", () => {
  const [usage, setUsage] = createSignal<ContextUsage | null>(null);
  render(() => (
    <SettingsProvider settings={settings}>
      <I18nProvider>
        <ThreadInfoCard
          usage={usage()}
          onManageMcps={() => undefined}
          onClose={() => undefined}
        />
      </I18nProvider>
    </SettingsProvider>
  ));
  expect(screen.getByText("Usage unavailable")).toBeTruthy();
  expect(screen.queryByRole("progressbar", { hidden: true })).toBeNull();
  setUsage({ used: 32_000, size: 100_000 });
  expect(screen.getByText("32% (32K/100K)").title).toBe(
    "32,000 / 100,000 tokens",
  );
  const progress = screen.getByRole("progressbar", { hidden: true });
  expect(progress.getAttribute("aria-valuenow")).toBe("32");
  expect(progress.getAttribute("aria-valuetext")).toBe(
    "32,000 / 100,000 tokens",
  );
  setUsage({ used: 12_345, size: 100_000 });
  expect(screen.getByText("12% (12.3K/100K)")).toBeTruthy();
  expect(progress.getAttribute("aria-valuenow")).toBe("12.345");
  setUsage({ used: 0, size: 100_000 });
  expect(screen.getByText("0% (0/100K)")).toBeTruthy();
  setUsage({ used: 32_000, size: 0 });
  expect(screen.getByText("Usage unavailable")).toBeTruthy();
  expect(screen.queryByRole("progressbar", { hidden: true })).toBeNull();
});

it("keeps raw counts below K and bounds the progress without altering reported usage", () => {
  render(() => (
    <SettingsProvider settings={settings}>
      <I18nProvider>
        <ThreadInfoCard
          usage={{ used: 999, size: 900 }}
          onManageMcps={() => undefined}
          onClose={() => undefined}
        />
      </I18nProvider>
    </SettingsProvider>
  ));
  expect(screen.getByText("111% (999/900)")).toBeTruthy();
  expect(
    screen
      .getByRole("progressbar", { hidden: true })
      .getAttribute("aria-valuenow"),
  ).toBe("100");
});

it("closes from the top-right action", () => {
  let closed = false;
  render(() => (
    <SettingsProvider settings={settings}>
      <I18nProvider>
        <ThreadInfoCard
          usage={null}
          onManageMcps={() => undefined}
          onClose={() => (closed = true)}
        />
      </I18nProvider>
    </SettingsProvider>
  ));

  fireEvent.click(
    screen.getByRole("button", { name: "Close thread information" }),
  );
  expect(closed).toBe(true);
});

it("distinguishes unavailable, empty, and populated MCP state reactively", async () => {
  const [mcp, setMcp] = createSignal<Thread["mcp"]>();
  render(() => (
    <SettingsProvider settings={settings}>
      <I18nProvider>
        <ThreadInfoCard
          usage={null}
          mcp={mcp()}
          onManageMcps={() => undefined}
          onClose={() => undefined}
        />
      </I18nProvider>
    </SettingsProvider>
  ));
  expect(screen.getByText("Information unavailable")).toBeTruthy();
  setMcp({
    servers: [],
    error: null,
    issues: [],
    revision: "1",
    reconnectRequired: false,
  });
  expect(screen.getByText("None")).toBeTruthy();
  const name = "a-very-long-server-name-that-does-not-fit";
  setMcp({
    servers: ["zeta", name, "beta", "delta", "echo", "foxtrot"],
    error: null,
    issues: [{ name, reason: "Sign in to this MCP server" }],
    revision: "2",
    reconnectRequired: false,
  });
  expect(
    screen.getAllByRole("listitem").map((item) => item.textContent),
  ).toEqual([name, "beta", "delta", "echo", "foxtrot", "zeta"]);
  expect(screen.getByTitle(name)).toBeTruthy();
  const issue = screen.getByRole("button", { name: `Issue with ${name}` });
  fireEvent.focus(issue);
  expect(await screen.findByRole("tooltip")).toHaveProperty(
    "textContent",
    "Sign in to this MCP server",
  );
  setMcp({
    servers: null,
    error: "Correct the settings file",
    issues: [],
    revision: "invalid",
    reconnectRequired: false,
  });
  expect(screen.getByText("Correct the settings file")).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
  expect(screen.queryByText("Information unavailable")).toBeNull();
});
