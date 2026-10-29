import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { type FileChangeItem, FileChanges } from "./FileChanges";

const file = (id: string, path = id): FileChangeItem => ({
  id,
  path,
  oldPath: null,
  additions: 3,
  deletions: 1,
});
afterEach(cleanup);

it("keeps identity-based expansion through updates and opens new entries", () => {
  const [items, setItems] = createSignal([
    file("staged", "src/a.ts"),
    file("unstaged", "src/a.ts"),
  ]);
  render(() => (
    <FileChanges items={items()} visible>
      {(item) => <p>{item().id} body</p>}
    </FileChanges>
  ));
  const toggles = screen.getAllByRole("button", { name: "src/a.ts 접기" });
  fireEvent.click(toggles[0]);
  expect(toggles.map((button) => button.getAttribute("aria-expanded"))).toEqual(
    ["false", "true"],
  );
  setItems([
    file("unstaged", "src/a.ts"),
    file("staged", "src/renamed.ts"),
    file("new"),
  ]);
  expect(
    screen.getByRole("button", { name: "src/renamed.ts 펼치기" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "new 접기" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "전체 펼치기" }));
  expect(
    screen.getByRole("button", { name: "src/renamed.ts 접기" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "전체 접기" }));
  setItems([file("new")]);
  setItems([file("new"), file("staged", "src/a.ts")]);
  expect(screen.getByRole("button", { name: "src/a.ts 접기" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "new 펼치기" })).toBeTruthy();
});

it("isolates header controls and filename clicks from the collapse button", async () => {
  const action = vi.fn();
  const user = userEvent.setup();
  render(() => (
    <FileChanges
      items={[file("src/a.ts")]}
      visible
      headerControls={() => (
        <button type="button" onClick={action}>
          Stage file
        </button>
      )}
      toolbarActions={
        <button type="button" onClick={action}>
          Stage all
        </button>
      }
    >
      {() => <button type="button">Body action</button>}
    </FileChanges>
  ));
  await user.click(screen.getByText("a.ts"));
  await user.click(screen.getByRole("button", { name: "Stage file" }));
  await user.click(screen.getByRole("button", { name: "Stage all" }));
  expect(action).toHaveBeenCalledTimes(2);
  const toggle = screen.getByRole("button", { name: "src/a.ts 접기" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  toggle.focus();
  await user.keyboard("{Enter}");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Body action" })).toBeNull();
  await user.keyboard(" ");
  await waitFor(() =>
    expect(toggle.getAttribute("aria-expanded")).toBe("true"),
  );
  expect(screen.getByRole("button", { name: "Body action" })).toBeTruthy();
});

it("disables the global toggle for an empty list", () => {
  render(() => (
    <FileChanges items={[]} visible empty={<p>Empty</p>}>
      {() => null}
    </FileChanges>
  ));
  expect(
    screen.getByRole("button", { name: "전체 접기" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByText("Empty")).toBeTruthy();
});

it("uses the canvas surface and compact file headers", () => {
  render(() => (
    <FileChanges items={[file("a.ts")]} visible>
      {() => null}
    </FileChanges>
  ));
  const toggle = screen.getByRole("button", { name: "a.ts 접기" });
  expect(toggle.classList.contains("size-6")).toBe(true);
  expect(
    toggle.parentElement?.parentElement?.classList.contains("bg-canvas"),
  ).toBe(true);
  expect(toggle.parentElement?.classList.contains("py-1")).toBe(true);
});

it("gives every file the same scroll container and keeps mounted content while collapsed", () => {
  const contexts: Array<{
    root: () => HTMLElement;
    content: () => HTMLElement;
  }> = [];
  const mounted = vi.fn();
  render(() => (
    <FileChanges items={[file("first"), file("second")]} visible>
      {(item, context) => {
        contexts.push({
          root: context.scrollRoot,
          content: context.scrollContent,
        });
        mounted();
        return <p>{item().id} body</p>;
      }}
    </FileChanges>
  ));
  expect(contexts).toHaveLength(2);
  expect(contexts[0].root()).toBe(contexts[1].root());
  expect(contexts[0].content()).toBe(contexts[1].content());
  fireEvent.click(screen.getByRole("button", { name: "first 접기" }));
  fireEvent.click(screen.getByRole("button", { name: "first 펼치기" }));
  expect(mounted).toHaveBeenCalledTimes(2);
});
