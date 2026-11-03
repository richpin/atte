import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { resolveExistingFile } from "features/workspace-files";
import { prepareFileChanges } from "shared/diff";
import { I18nProvider } from "shared/i18n";
import { ToastHost } from "shared/ui";
import { createSignal, onCleanup } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadPanelContentProps } from "../model/thread-panel";
import { createThreadPanelModel } from "./create-thread-panel-model";
import { ThreadPanelLayout } from "./ThreadPanelLayout";

vi.mock("features/workspace-files", async (original) => ({
  ...(await original<object>()),
  resolveExistingFile: vi.fn(),
  WorkspaceFiles: () => <p>Files</p>,
}));
vi.mock("./git/GitPanel", () => ({ GitPanel: () => <p>Git</p> }));

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
  const closeThread = vi.fn();
  const closeWindow = vi.fn();
  render(() => (
    <I18nProvider>
      <ThreadPanelLayout
        model={model}
        threadId={threadId()}
        active={active()}
        panelId="project-panel"
        onCloseThread={closeThread}
        onCloseWindow={closeWindow}
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
  return {
    model,
    setThreadId,
    setActive,
    closeThread,
    closeWindow,
    handle,
    panel,
    resize,
  };
}

it("opens an available changed file in the reusable Files tab", async () => {
  vi.mocked(resolveExistingFile).mockResolvedValueOnce("src/a.ts");
  let model!: ReturnType<typeof createThreadPanelModel>;
  function TestModel() {
    model = createThreadPanelModel();
    return null;
  }
  render(() => (
    <I18nProvider>
      <TestModel />
    </I18nProvider>
  ));
  await model.openFile("one", "/workspace/src/a.ts");
  expect(resolveExistingFile).toHaveBeenCalledWith(
    "one",
    "/workspace/src/a.ts",
  );
  expect(model.panel("one")?.selectedTabId).toBe("files:one");
  expect(model.panel("one")?.tabs).toHaveLength(1);
});

it.each([
  ["Files", "files:one"],
  ["Git", "git:one"],
  ["Web", null],
])("keeps a chosen %s view at its new tab's position", async (view, id) => {
  const { model } = setup();
  model.setOpen("one", true);
  model.newTab("one");
  const first = model.panel("one")?.tabs[0];
  const second = model.panel("one")?.tabs[1];
  if (!first || !second) throw new Error("Missing new tabs");
  model.selectTab("one", first.id);

  await userEvent.click(screen.getByRole("button", { name: view }));

  expect(model.panel("one")?.tabs.map((tab) => tab.id)).toEqual([
    id ?? first.id,
    second.id,
  ]);
  expect(model.panel("one")?.tabs[1]?.title()).toBe("새 탭");
  expect(model.panel("one")?.selectedTabId).toBe(id ?? first.id);
});

it("reuses an existing Files tab when chosen from another new tab", async () => {
  const { model } = setup();
  model.setOpen("one", true);
  await userEvent.click(screen.getByRole("button", { name: "Files" }));
  model.newTab("one");

  await userEvent.click(screen.getByRole("button", { name: "Files" }));

  expect(model.panel("one")?.tabs.map((tab) => tab.id)).toEqual(["files:one"]);
  expect(model.panel("one")?.selectedTabId).toBe("files:one");
});

it("keeps the current tab when a changed file is unavailable and shows a toast", async () => {
  vi.mocked(resolveExistingFile).mockRejectedValueOnce(new Error("missing"));
  let model!: ReturnType<typeof createThreadPanelModel>;
  function TestModel() {
    model = createThreadPanelModel();
    model.newTab("one");
    return <ToastHost />;
  }
  render(() => (
    <I18nProvider>
      <TestModel />
    </I18nProvider>
  ));
  const selected = model.panel("one")?.selectedTabId;
  await model.openFile("one", "/workspace/deleted.ts");
  expect(model.panel("one")?.selectedTabId).toBe(selected);
  expect(model.panel("one")?.tabs.some((tab) => tab.id === "files:one")).toBe(
    false,
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "deleted.ts",
  );
});

it("reuses a turn's changes tab and preserves its file list alongside web tabs", async () => {
  const { model } = setup();
  const files = await prepareFileChanges([
    { path: "/project/a.ts", comparisons: [{ before: "old", after: "new" }] },
  ]);
  model.openChangesTab("one", "turn-1", files);
  const trigger = screen.getByRole("button", { name: "/project/a.ts 접기" });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  // Keep the renderer closed here; its own tests cover asynchronous resources.
  fireEvent.click(trigger);
  model.openChangesTab("one", "turn-1", files);
  expect(
    model.panel("one")?.tabs.filter((tab) => tab.id === "changes:turn-1"),
  ).toHaveLength(1);
  model.newTab("one");
  expect(screen.getByRole("button", { name: "Web" })).toBeTruthy();
  model.selectTab("one", "changes:turn-1");
  expect(screen.getByRole("button", { name: "/project/a.ts 펼치기" })).toBe(
    trigger,
  );
  model.setOpen("one", false);
  model.openChangesTab("one", "turn-1", files);
  expect(screen.getByRole("button", { name: "/project/a.ts 펼치기" })).toBe(
    trigger,
  );
  model.openChangesTab("one", "turn-2", files);
  expect(
    model.panel("one")?.tabs.filter((tab) => tab.id.startsWith("changes:")),
  ).toHaveLength(2);
});

it("closes the panel with its last tab and starts with a new tab when reopened", async () => {
  const { model } = setup();
  expect(screen.queryByRole("complementary")).toBeNull();
  model.setOpen("one", true);
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe("새 탭");
  const add = screen.getByRole("button", { name: "새 탭" });
  await userEvent.click(add);
  await userEvent.click(add);
  expect(screen.getAllByRole("tab")).toHaveLength(3);
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe("새 탭");
  await userEvent.click(screen.getAllByRole("tab")[1]);
  await userEvent.click(
    screen.getAllByRole("button", { name: "새 탭 닫기" })[1],
  );
  expect(screen.getByRole("tab", { selected: true })).toBe(
    screen.getAllByRole("tab")[1],
  );
  expect(document.activeElement).toBe(screen.getAllByRole("tab")[1]);
  await userEvent.click(
    screen.getAllByRole("button", { name: "새 탭 닫기" })[1],
  );
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe("새 탭");
  await userEvent.click(screen.getByRole("button", { name: "새 탭 닫기" }));
  expect(model.panel("one")?.tabs).toHaveLength(0);
  expect(model.panel("one")?.open).toBe(false);
  expect(screen.queryByRole("complementary")).toBeNull();
  model.setOpen("one", true);
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe("새 탭");
  await userEvent.click(add);
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe("새 탭");
});

it("uses standard tab shortcuts for the active project panel", async () => {
  const { model, setThreadId, setActive, closeThread, closeWindow } = setup();
  model.setOpen("one", true);
  fireEvent.keyDown(window, { key: "t", metaKey: true });
  expect(model.panel("one")?.tabs).toHaveLength(2);
  expect(model.panel("one")?.selectedTabId).toBe(
    model.panel("one")?.tabs[1]?.id,
  );

  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
  expect(model.panel("one")?.selectedTabId).toBe(
    model.panel("one")?.tabs[0]?.id,
  );
  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
  expect(model.panel("one")?.selectedTabId).toBe(
    model.panel("one")?.tabs[1]?.id,
  );
  fireEvent.keyDown(window, { key: "2", metaKey: true });
  expect(model.panel("one")?.selectedTabId).toBe(
    model.panel("one")?.tabs[1]?.id,
  );
  fireEvent.keyDown(window, {
    key: "{",
    code: "BracketLeft",
    metaKey: true,
    shiftKey: true,
  });
  expect(model.panel("one")?.selectedTabId).toBe(
    model.panel("one")?.tabs[0]?.id,
  );
  fireEvent.keyDown(window, { key: "9", metaKey: true });
  expect(model.panel("one")?.selectedTabId).toBe(
    model.panel("one")?.tabs[1]?.id,
  );
  fireEvent.keyDown(window, { key: "8", metaKey: true });
  expect(model.panel("one")?.selectedTabId).toBe(
    model.panel("one")?.tabs[1]?.id,
  );
  fireEvent.keyDown(window, { key: "w", metaKey: true });
  expect(model.panel("one")?.tabs).toHaveLength(1);

  fireEvent.keyDown(window, { key: "w", metaKey: true });
  expect(model.panel("one")?.open).toBe(false);
  fireEvent.keyDown(window, { key: "w", metaKey: true });
  expect(closeThread).toHaveBeenCalledTimes(1);

  setThreadId("two");
  fireEvent.keyDown(window, { key: "t", metaKey: true });
  expect(model.panel("two")?.tabs).toHaveLength(1);
  setActive(false);
  fireEvent.keyDown(window, { key: "t", metaKey: true });
  expect(model.panel("two")?.tabs).toHaveLength(1);
  fireEvent.keyDown(window, { key: "w", metaKey: true });
  expect(closeWindow).toHaveBeenCalledTimes(1);
});

it("keeps a tab open when its close guard rejects the shortcut", async () => {
  const { model } = setup();
  const beforeClose = vi.fn().mockResolvedValue(false);
  model.openTab("one", {
    id: "unsaved",
    title: () => "Unsaved",
    content: () => <p>Unsaved changes</p>,
    beforeClose,
  });
  fireEvent.keyDown(window, { key: "w", metaKey: true });
  await waitFor(() => expect(beforeClose).toHaveBeenCalledTimes(1));
  expect(model.panel("one")?.tabs).toHaveLength(1);
  expect(model.panel("one")?.open).toBe(true);
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
  expect(screen.getByRole("tab", { selected: true }).textContent).toBe("새 탭");
  model.newTab("two");
  expect(model.panel("two")?.tabs).toHaveLength(1);
});

it("uses Kobalte keyboard navigation and keeps selection when closing another tab", async () => {
  const { model } = setup();
  model.setOpen("one", true);
  const add = screen.getByRole("button", { name: "새 탭" });
  for (let index = 0; index < 2; index++) await userEvent.click(add);
  const first = screen.getAllByRole("tab")[0];
  await userEvent.click(first);
  await userEvent.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { selected: true })).toBe(
    screen.getAllByRole("tab")[1],
  );
  await userEvent.keyboard("{End}");
  expect(screen.getByRole("tab", { selected: true })).toBe(
    screen.getAllByRole("tab")[2],
  );
  await userEvent.keyboard("{Home}");
  expect(screen.getByRole("tab", { selected: true })).toBe(first);
  await userEvent.click(
    screen.getAllByRole("button", { name: "새 탭 닫기" })[1],
  );
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
