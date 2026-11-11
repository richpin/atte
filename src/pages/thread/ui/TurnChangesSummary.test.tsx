import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { I18nProvider } from "shared/i18n";
import { createMemorySettings, SettingsProvider } from "shared/settings";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Turn } from "../model/types";
import { TurnChangesSummary } from "./TurnChangesSummary";

let settings = createMemorySettings();
beforeEach(() => {
  settings = createMemorySettings();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});
function fixture(): Turn {
  return {
    id: "turn",
    message: "",
    stopReason: null,
    responseParts: [
      {
        kind: "tool",
        id: "edit",
        tool: {
          status: "completed",
          content: [
            {
              type: "diff",
              path: "a.ts",
              oldText: "old\n",
              newText: "new\nextra\n",
            },
          ],
        },
      },
    ],
  };
}

it("shows one summary after completion and opens the exact reported versions", async () => {
  settings = createMemorySettings({ ...settings.values(), locale: "en" });
  const [active, setActive] = createSignal(true);
  const onOpen = vi.fn();
  render(() => (
    <SettingsProvider settings={settings}>
      <I18nProvider>
        <TurnChangesSummary
          turn={fixture()}
          active={active()}
          onOpen={onOpen}
        />
      </I18nProvider>
    </SettingsProvider>
  ));
  expect(screen.queryByRole("button")).toBeNull();
  setActive(false);
  const summary = await screen.findByRole("button", {
    name: /1 files changed.*View changes/,
  });
  expect(summary.textContent).toContain("+2");
  expect(summary.textContent).toContain("−1");
  fireEvent.click(summary);
  expect(onOpen.mock.calls[0][0]).toBe("turn");
  expect(onOpen.mock.calls[0][1][0].comparisons[0]).toMatchObject({
    before: "old\n",
    after: "new\nextra\n",
  });
  setActive(true);
  expect(screen.queryByRole("button")).toBeNull();
});

it("shows totals for replayed discontinuous edits without requiring a stop reason", async () => {
  settings = createMemorySettings({ ...settings.values(), locale: "en" });
  const value = fixture();
  value.responseParts.push({
    kind: "tool",
    id: "edit-2",
    tool: {
      status: "completed",
      content: [
        { type: "diff", path: "a.ts", oldText: "external", newText: "final" },
      ],
    },
  });
  render(() => (
    <SettingsProvider settings={settings}>
      <I18nProvider>
        <TurnChangesSummary turn={value} active={false} />
      </I18nProvider>
    </SettingsProvider>
  ));
  const summary = await screen.findByRole("button", {
    name: /1 files changed.*View changes/,
  });
  expect(summary.textContent).toContain("+3");
  expect(summary.textContent).toContain("−2");
  expect(summary.textContent).not.toContain("reported edits");
});

it("replaces a tool's partial update without double counting and hides a reverted result", async () => {
  settings = createMemorySettings({ ...settings.values(), locale: "en" });
  const [value, setValue] = createSignal(fixture());
  render(() => (
    <SettingsProvider settings={settings}>
      <I18nProvider>
        <TurnChangesSummary turn={value()} active={false} />
      </I18nProvider>
    </SettingsProvider>
  ));
  await screen.findByRole("button", { name: /View changes/ });
  setValue({ ...fixture(), responseParts: [] });
  await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
});
