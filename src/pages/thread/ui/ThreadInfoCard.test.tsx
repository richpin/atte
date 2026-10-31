import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { I18nProvider } from "shared/i18n";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ContextUsage } from "../model/types";
import { ThreadInfoCard } from "./ThreadInfoCard";

beforeEach(() => localStorage.setItem("atte.locale", "en"));
afterEach(cleanup);

it("reacts to replacement and compaction with exact accessible usage", () => {
  const [usage, setUsage] = createSignal<ContextUsage | null>(null);
  render(() => (
    <I18nProvider>
      <ThreadInfoCard usage={usage()} onClose={() => undefined} />
    </I18nProvider>
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
    <I18nProvider>
      <ThreadInfoCard
        usage={{ used: 999, size: 900 }}
        onClose={() => undefined}
      />
    </I18nProvider>
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
    <I18nProvider>
      <ThreadInfoCard usage={null} onClose={() => (closed = true)} />
    </I18nProvider>
  ));

  fireEvent.click(
    screen.getByRole("button", { name: "Close thread information" }),
  );
  expect(closed).toBe(true);
});
