import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
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

it("totals all files and reported edits in the toolbar and file rows", async () => {
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
  expect(screen.queryByRole("heading", { name: "Changes" })).toBeNull();
  expect(container.textContent).toContain("2 files changed");
  expect(container.textContent).not.toContain("reported edits");
  expect(
    screen.getByRole("img", { name: /5 additions, 2 deletions/ }),
  ).toBeTruthy();
  const first = screen.getByText("a.ts").parentElement?.parentElement;
  expect(first?.textContent).toContain("+3");
  expect(first?.textContent).toContain("−2");
  expect(screen.getByText("Edit 1")).toBeTruthy();
  expect(screen.getByText("Edit 2")).toBeTruthy();
});

it("opens the current file from a reported change without collapsing its diff", async () => {
  const files = await prepareFileChanges([
    { path: "src/a.ts", comparisons: [{ before: "old", after: "new" }] },
  ]);
  const onOpenFile = vi.fn();
  render(() => (
    <I18nProvider>
      <ChangesReview files={files} visible onOpenFile={onOpenFile} />
    </I18nProvider>
  ));
  await userEvent.setup().click(screen.getByRole("button", { name: "a.ts" }));
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("src/a.ts");
  expect(
    screen
      .getByRole("button", { name: /src\/a.ts 접기|Collapse src\/a.ts/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
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
  await user.tab();
  const trigger = screen.getByRole("button", {
    name: "Collapse /project/a.ts",
  });
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await user.keyboard(" ");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});

it("starts expanded, independently collapses files, and preserves state when hidden", async () => {
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
  const first = screen.getByRole("button", { name: "Collapse /project/a.ts" });
  const second = screen.getByRole("button", { name: "Collapse /project/b.ts" });
  expect(first.getAttribute("aria-expanded")).toBe("true");
  expect(second.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("first diff")).toBeTruthy();
  fireEvent.click(first);
  expect(first.getAttribute("aria-expanded")).toBe("false");
  expect(second.getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByText("first diff")).toBeNull();
  const root = screen.getByRole("region", { name: "Changes" });
  const scroll = root.querySelector(".overflow-auto");
  if (!(scroll instanceof HTMLElement)) throw new Error("missing scroll area");
  scroll.scrollTop = 80;
  setVisible(false);
  setVisible(true);
  expect(scroll.scrollTop).toBe(80);
  expect(first.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(first);
  expect(first.getAttribute("aria-expanded")).toBe("true");
  expect(second.getAttribute("aria-expanded")).toBe("true");
});
