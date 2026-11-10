import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "shared/i18n";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { findThreadMatches } from "../lib/thread-search";
import { Thought } from "./Thought";
import { WorkLog } from "./WorkLog";

beforeEach(() => localStorage.setItem("atte.locale", "en"));
afterEach(cleanup);

it("excludes folded content from search while preserving the nested disclosure", () => {
  const [collecting, setCollecting] = createSignal(true);
  const view = render(() => (
    <I18nProvider>
      <WorkLog count={1} collecting={collecting()}>
        {() => (
          <Thought
            part={{
              kind: "thought",
              id: "thought",
              text: "Searchable reasoning",
            }}
            active={false}
          />
        )}
      </WorkLog>
    </I18nProvider>
  ));
  fireEvent.click(screen.getByRole("button", { name: "Thinking" }));
  expect(findThreadMatches(view.container, "Searchable")).toHaveLength(1);
  setCollecting(false);
  expect(findThreadMatches(view.container, "Searchable")).toHaveLength(0);
  const log = screen.getByRole("button", { name: "Work log · 1 item" });
  fireEvent.click(log);
  expect(findThreadMatches(view.container, "Searchable")).toHaveLength(1);
  expect(
    screen
      .getByRole("button", { name: "Thinking" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  fireEvent.click(log);
  expect(findThreadMatches(view.container, "Searchable")).toHaveLength(0);
});

it.each([
  ["en", "Work log · 1 item", "Work log · 2 items"],
  ["ko", "작업 과정 · 1개", "작업 과정 · 2개"],
])(
  "supports keyboard toggling and item counts in %s",
  async (locale, singular, plural) => {
    localStorage.setItem("atte.locale", locale);
    const user = userEvent.setup();
    const [count, setCount] = createSignal(1);
    render(() => (
      <I18nProvider>
        <WorkLog count={count()} collecting={false}>
          {() => <p>Activity</p>}
        </WorkLog>
      </I18nProvider>
    ));
    await user.tab();
    const trigger = screen.getByRole("button", { name: singular });
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBeTruthy();
    setCount(2);
    expect(screen.getByRole("button", { name: plural })).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard(" ");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  },
);
