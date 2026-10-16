import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { prepareFileChanges } from "shared/diff";
import { I18nProvider } from "shared/i18n";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { ChangesReview } from "./ChangesReview";

vi.mock("shared/ui", async (original) => ({
  ...(await original<typeof import("shared/ui")>()),
  FileDiff: (props: { comparison: { after: string } }) => (
    <pre>{props.comparison.after}</pre>
  ),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("always totals all files and reported edits in the header and file rows", async () => {
  localStorage.setItem("atte.locale", "en");
  const files = await prepareFileChanges([
    {
      path: "a.ts",
      comparisons: [
        { before: "old\n", after: "one\ntwo\n" },
        { before: "external\n", after: "three\n" },
      ],
    },
    { path: "b.ts", comparisons: [{ before: null, after: "four\nfive\n" }] },
  ]);
  const { container } = render(() => (
    <I18nProvider>
      <ChangesReview files={files} visible />
    </I18nProvider>
  ));
  const header = container.querySelector("header");
  if (!header) throw new Error("missing header");
  expect(header.textContent).toContain("2 files changed");
  expect(container.textContent).not.toContain("reported edits");
  expect(within(header).getByText("+5")).toBeTruthy();
  expect(within(header).getByText("−2")).toBeTruthy();
  const first = screen.getByRole("button", { name: /a.ts/ });
  expect(first.textContent).toContain("+3");
  expect(first.textContent).toContain("−2");
});

it("opens and closes file rows with the keyboard", async () => {
  localStorage.setItem("atte.locale", "en");
  const files = await prepareFileChanges([
    { path: "/project/a.ts", comparisons: [{ before: "old", after: "new" }] },
  ]);
  render(() => (
    <I18nProvider>
      <ChangesReview files={files} visible />
    </I18nProvider>
  ));
  const user = userEvent.setup();
  await user.tab();
  const trigger = screen.getByRole("button", { name: /a.ts/ });
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await user.keyboard(" ");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("starts collapsed, independently expands multiple files, and preserves state when hidden", async () => {
  localStorage.setItem("atte.locale", "en");
  const files = await prepareFileChanges([
    {
      path: "/project/a.ts",
      comparisons: [{ before: "a", after: "first diff" }],
    },
    {
      path: "/project/b.ts",
      comparisons: [{ before: "b", after: "second diff" }],
    },
  ]);
  const [visible, setVisible] = createSignal(true);
  render(() => (
    <I18nProvider>
      <ChangesReview files={files} visible={visible()} />
    </I18nProvider>
  ));
  const first = screen.getByRole("button", { name: /a.ts/ });
  const second = screen.getByRole("button", { name: /b.ts/ });
  expect(first.getAttribute("aria-expanded")).toBe("false");
  expect(second.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("first diff")).toBeNull();
  fireEvent.click(first);
  fireEvent.click(second);
  expect(first.getAttribute("aria-expanded")).toBe("true");
  expect(second.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("first diff")).toBeTruthy();
  const root = screen.getByRole("region", { name: "Changes" });
  root.scrollTop = 80;
  setVisible(false);
  setVisible(true);
  expect(root.scrollTop).toBe(80);
  expect(first.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(first);
  expect(first.getAttribute("aria-expanded")).toBe("false");
  expect(second.getAttribute("aria-expanded")).toBe("true");
});
