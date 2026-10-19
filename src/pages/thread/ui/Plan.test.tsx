import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { I18nProvider } from "shared/i18n";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Plan as PlanData } from "../model/types";
import { Plan } from "./Plan";

beforeEach(() => localStorage.setItem("atte.locale", "en"));
afterEach(cleanup);

it("retains collapsed state through replacement, clearing and restoration", () => {
  const [plan, setPlan] = createSignal<PlanData>({
    entries: [
      { content: "Read", priority: "high", status: "completed" },
      {
        content: "**Test** <script>unsafe</script>",
        priority: "low",
        status: "in_progress",
      },
    ],
  });
  render(() => (
    <I18nProvider>
      <Plan plan={plan()} active />
    </I18nProvider>
  ));
  expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("1/2 completed")).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("button").textContent).toContain(
    "**Test** <script>unsafe</script>",
  );
  setPlan({
    entries: [
      { content: "Changed", priority: "medium", status: "in_progress" },
    ],
  });
  expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(screen.getByRole("button").textContent).toContain("Changed");
  setPlan({ entries: [] });
  expect(screen.queryByRole("button")).toBeNull();
  setPlan({
    entries: [{ content: "Restored", priority: "high", status: "pending" }],
  });
  expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(screen.getByText("0/1 completed")).toBeTruthy();
});

it("stops animation without changing unfinished status and preserves agent order", () => {
  const [active, setActive] = createSignal(true);
  const entries: PlanData["entries"] = [
    { content: "Low first", priority: "low", status: "in_progress" },
    { content: "High second", priority: "high", status: "pending" },
  ];
  const { container } = render(() => (
    <I18nProvider>
      <Plan plan={{ entries }} active={active()} />
    </I18nProvider>
  ));
  expect(
    [...container.querySelectorAll("li")].map((row) => row.textContent),
  ).toEqual(["In progressLow first", "PendingHigh second"]);
  expect(container.querySelector("l-tailspin")?.getAttribute("speed")).toBe(
    "0.9",
  );
  setActive(false);
  expect(container.querySelector("l-tailspin")?.getAttribute("speed")).toBe(
    "0",
  );
  expect(screen.getByText("In progress")).toBeTruthy();
  expect(screen.getByText("0/2 completed")).toBeTruthy();
});
