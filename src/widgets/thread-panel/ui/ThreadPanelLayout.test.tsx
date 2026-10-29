import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { prepareFileChanges } from "shared/diff";
import { I18nProvider } from "shared/i18n";
import { createSignal, onCleanup } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadPanelContentProps } from "../model/thread-panel";
import { createThreadPanelModel } from "./create-thread-panel-model";
import { ThreadPanelLayout } from "./ThreadPanelLayout";

let layoutWidth: number;
let observers: ResizeObserverFixture[];

class ResizeObserverFixture {
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}

beforeEach(() => {
  layoutWidth = 900;
  observers = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverFixture);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    () => layoutWidth,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const model = createThreadPanelModel();
  const [threadId, setThreadId] = createSignal("one");
  const [active, setActive] = createSignal(true);
  render(() => (
    <I18nProvider>
      <ThreadPanelLayout
        model={model}
        threadId={threadId()}
        active={active()}
        panelId="project-panel"
      >
        <main>Conversation</main>
      </ThreadPanelLayout>
    </I18nProvider>
  ));
  const handle = screen.getByRole("separator", {
    name: "프로젝트 패널 너비 조절",
  });
  const panel = handle.nextElementSibling as HTMLElement;
  const root = handle.parentElement as HTMLElement;
  function resize(width: number) {
    layoutWidth = width;
    for (const observer of observers) {
      if (observer.targets.has(root)) {
        observer.callback(
          [
            {
              target: root,
              contentRect: new DOMRect(0, 0, width, 600),
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            },
          ],
          observer as unknown as ResizeObserver,
        );
      }
    }
  }
  return { model, setThreadId, setActive, handle, panel, resize };
}

it("reuses a turn's changes tab and preserves its file list alongside web tabs", async () => {
  const { model } = setup();
  const files = await prepareFileChanges([
    { path: "/project/a.ts", comparisons: [{ before: "old", after: "new" }] },
  ]);
  model.openChangesTab("one", "turn-1", files);
  const trigger = screen.getByRole("button", { name: /a.ts/ });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  // Keep the renderer closed here; its own tests cover asynchronous resources.
  fireEvent.click(trigger);
  model.openChangesTab("one", "turn-1", files);
  expect(
    model.panel("one")?.tabs.filter((tab) => tab.id === "changes:turn-1"),
  ).toHaveLength(1);
  model.newTab("one");
  expect(screen.getByRole("button", { name: "웹" })).toBeTruthy();
  model.selectTab("one", "changes:turn-1");
  expect(screen.getByRole("button", { name: /a.ts/ })).toBe(trigger);
  model.setOpen("one", false);
  model.openChangesTab("one", "turn-1", files);
  expect(screen.getByRole("button", { name: /a.ts/ })).toBe(trigger);
  model.openChangesTab("one", "turn-2", files);
  expect(
    model.panel("one")?.tabs.filter((tab) => tab.id.startsWith("changes:")),
  ).toHaveLength(2);
});

it("closes the panel with its last tab and starts at tab one when reopened", async () => {
  const { model } = setup();
  expect(screen.queryByRole("complementary")).toBeNull();
  model.setOpen("one", true);
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
    "새 탭 1",
  );
  const add = screen.getByRole("button", { name: "새 탭" });
  await userEvent.click(add);
  await userEvent.click(add);
  expect(screen.getAllByRole("tab")).toHaveLength(3);
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
    "새 탭 3",
  );
  await userEvent.click(screen.getByRole("tab", { name: "새 탭 2" }));
  await userEvent.click(screen.getByRole("button", { name: "새 탭 2 닫기" }));
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
    "새 탭 3",
  );
  expect(document.activeElement).toBe(
    screen.getByRole("tab", { name: "새 탭 3" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "새 탭 3 닫기" }));
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
    "새 탭 1",
  );
  await userEvent.click(screen.getByRole("button", { name: "새 탭 1 닫기" }));
  expect(model.panel("one")?.tabs).toHaveLength(0);
  expect(model.panel("one")?.open).toBe(false);
  expect(screen.queryByRole("complementary")).toBeNull();
  model.setOpen("one", true);
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
    "새 탭 1",
  );
  await userEvent.click(add);
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
    "새 탭 2",
  );
});

it("closes the last custom tab through the public interface and cleans up its content while folded", () => {
  const { model } = setup();
  const disposed = vi.fn();
  model.openTab("one", {
    id: "file",
    title: () => "File",
    content: () => {
      onCleanup(disposed);
      return <p>File contents</p>;
    },
  });
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  model.setOpen("one", false);
  model.closeTab("one", "file");
  expect(disposed).toHaveBeenCalledTimes(1);
  expect(model.panel("one")?.open).toBe(false);
  expect(model.panel("one")?.tabs).toHaveLength(0);
  model.setOpen("one", true);
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
    "새 탭 1",
  );
  model.newTab("two");
  expect(model.panel("two")?.tabs).toHaveLength(1);
});

it("uses Kobalte keyboard navigation and keeps selection when closing another tab", async () => {
  const { model } = setup();
  model.setOpen("one", true);
  const add = screen.getByRole("button", { name: "새 탭" });
  for (let index = 0; index < 2; index++) await userEvent.click(add);
  const first = screen.getByRole("tab", { name: "새 탭 1" });
  await userEvent.click(first);
  await userEvent.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
    "새 탭 2",
  );
  await userEvent.keyboard("{End}");
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
    "새 탭 3",
  );
  await userEvent.keyboard("{Home}");
  expect(screen.getByRole("tab", { selected: true })).toBe(first);
  await userEvent.click(screen.getByRole("button", { name: "새 탭 2 닫기" }));
  expect(screen.getByRole("tab", { selected: true })).toBe(first);
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
});

it("preserves content across tab selection, folding, screen and thread changes and disposes on removal", async () => {
  const { model, setThreadId, setActive } = setup();
  const disposed = vi.fn();
  function Content(props: ThreadPanelContentProps) {
    const [value, setValue] = createSignal("");
    onCleanup(disposed);
    return (
      <>
        <input
          aria-label="Tab draft"
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        <p>{props.active ? "selected" : "inactive"}</p>
        <p>{props.visible ? "visible" : "hidden"}</p>
      </>
    );
  }
  const tab = { id: "file", title: () => "File", content: Content };
  model.openTab("one", tab);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Tab draft" }),
    "Draft",
  );
  await userEvent.click(screen.getByRole("button", { name: "새 탭" }));
  model.openTab("one", tab);
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(screen.getByRole("textbox")).toHaveProperty("value", "Draft");
  model.setOpen("one", false);
  expect(screen.queryByRole("textbox")).toBeNull();
  model.setOpen("one", true);
  setActive(false);
  expect(screen.queryByRole("complementary")).toBeNull();
  setActive(true);
  setThreadId("two");
  expect(screen.queryByRole("complementary")).toBeNull();
  model.setOpen("two", true);
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "새 탭" }));
  setThreadId("one");
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(screen.getByRole("textbox")).toHaveProperty("value", "Draft");
  expect(screen.getByText("visible")).toBeTruthy();
  expect(disposed).not.toHaveBeenCalled();
  model.closeTab("one", "file");
  expect(disposed).toHaveBeenCalledTimes(1);
  model.openTab("one", tab);
  model.forget("one");
  expect(disposed).toHaveBeenCalledTimes(2);
  expect(model.panel("one")).toBeUndefined();
});

it("resizes through the separator, remembers each thread's width and clamps without losing it", async () => {
  const { model, handle, panel, resize, setThreadId } = setup();
  model.setOpen("one", true);
  await waitFor(() =>
    expect(Number.parseFloat(panel.style.flexBasis)).toBeCloseTo(50),
  );
  expect(model.panel("one")?.width).toBeNull();
  resize(1000);
  expect(Number.parseFloat(panel.style.flexBasis)).toBeCloseTo(50);
  resize(900);
  expect(Number.parseFloat(panel.style.flexBasis)).toBeCloseTo(50);
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  await waitFor(() => expect(model.panel("one")?.width).toBeCloseTo(540));
  model.setOpen("one", false);
  expect(panel.style.flexBasis).toBe("0%");
  model.setOpen("one", true);
  expect(Number.parseFloat(panel.style.flexBasis)).toBeCloseTo(
    (540 / 900) * 100,
  );
  resize(512);
  await waitFor(() =>
    expect(Number.parseFloat(panel.style.flexBasis)).toBeCloseTo(
      (256 / 512) * 100,
    ),
  );
  expect(model.panel("one")?.width).toBeCloseTo(540);
  resize(511);
  expect(panel.style.flexBasis).toBe("0%");
  expect(screen.getByRole("main")).toBeTruthy();
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(model.panel("one")?.open).toBe(true);
  expect(handle).toHaveProperty("disabled", true);
  resize(900);
  expect(Number.parseFloat(panel.style.flexBasis)).toBeCloseTo(
    (540 / 900) * 100,
  );
  setThreadId("two");
  expect(panel.style.flexBasis).toBe("0%");
  model.setOpen("two", true);
  expect(Number.parseFloat(panel.style.flexBasis)).toBeCloseTo(50);
  setThreadId("one");
  expect(Number.parseFloat(panel.style.flexBasis)).toBeCloseTo(
    (540 / 900) * 100,
  );
  fireEvent.keyDown(handle, { key: "End" });
  await waitFor(() => expect(model.panel("one")?.open).toBe(false));
  fireEvent.keyDown(handle, { key: "Enter" });
  await waitFor(() =>
    expect(Number.parseFloat(panel.style.flexBasis)).toBeCloseTo(
      (540 / 900) * 100,
    ),
  );
});

it("fills the thread body when the conversation collapses and restores a split when resized back", async () => {
  const { model, handle, panel } = setup();
  model.setOpen("one", true);
  fireEvent.keyDown(handle, { key: "Home" });
  await waitFor(() => expect(panel.style.flexBasis).toBe("100%"));
  expect(model.panel("one")?.fullWidth).toBe(true);
  expect(screen.queryByRole("main")).toBeNull();
  expect(screen.getByRole("complementary")).toBeTruthy();
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  await waitFor(() => expect(model.panel("one")?.fullWidth).toBe(false));
  expect(screen.getByRole("main")).toBeTruthy();
  expect(Number.parseFloat(panel.style.flexBasis)).toBeLessThan(100);
});

it("preserves tab content through full-width mode, folding and window resizing", async () => {
  const { model, handle, panel, resize } = setup();
  const disposed = vi.fn();
  model.openTab("one", {
    id: "persistent",
    title: () => "Persistent",
    content: () => {
      onCleanup(disposed);
      return <input aria-label="Preserved tab" />;
    },
  });
  await userEvent.type(
    screen.getByRole("textbox", { name: "Preserved tab" }),
    "Keep this",
  );
  fireEvent.keyDown(handle, { key: "Home" });
  await waitFor(() => expect(panel.style.flexBasis).toBe("100%"));
  resize(511);
  expect(panel.style.flexBasis).toBe("0%");
  expect(screen.getByRole("main")).toBeTruthy();
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(model.panel("one")?.fullWidth).toBe(true);
  resize(1200);
  expect(panel.style.flexBasis).toBe("100%");
  model.setOpen("one", false);
  expect(screen.getByRole("main")).toBeTruthy();
  model.setOpen("one", true);
  expect(panel.style.flexBasis).toBe("100%");
  expect(screen.getByRole("textbox", { name: "Preserved tab" })).toHaveProperty(
    "value",
    "Keep this",
  );
  expect(disposed).not.toHaveBeenCalled();
  model.setWidth("one", 700);
  expect(model.panel("one")?.width).toBe(700);
  expect(screen.getByRole("main")).toBeTruthy();
});
