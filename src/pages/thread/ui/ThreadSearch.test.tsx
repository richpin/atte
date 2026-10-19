import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThreadTimeline } from "./ThreadTimeline";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperties(Range.prototype, {
    getBoundingClientRect: {
      configurable: true,
      value: () => new DOMRect(0, 100, 50, 20),
    },
    getClientRects: { configurable: true, value: () => [] },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
});

function findInput() {
  return screen.getByRole("searchbox", {
    name: "대화에서 찾기",
  }) as HTMLInputElement;
}

function open() {
  fireEvent.keyDown(document, { key: "f", ctrlKey: true });
  return findInput();
}

it("keeps the full timeline viewport and reading position when opening and closing find", () => {
  render(() => (
    <ThreadTimeline active followKey="one">
      <div data-thread-search-root>
        <p>Conversation history</p>
      </div>
    </ThreadTimeline>
  ));
  const viewport = screen.getByRole("region");
  viewport.scrollTop = 200;
  fireEvent.scroll(viewport);
  const top = getComputedStyle(viewport).top;
  open();
  expect(getComputedStyle(viewport).top).toBe(top);
  expect(viewport.scrollTop).toBe(200);
  fireEvent.keyDown(findInput(), { key: "Escape" });
  expect(getComputedStyle(viewport).top).toBe(top);
  expect(viewport.scrollTop).toBe(200);
});

it("opens, focuses, counts occurrences, wraps navigation, and restores focus without moving the timeline", async () => {
  render(() => (
    <>
      <textarea aria-label="Draft" />
      <ThreadTimeline
        active
        threadId="one"
        followKey="one:turn"
        overlay={<aside>Context info</aside>}
      >
        <div data-thread-search-root>
          <p>
            Hello <strong>hello</strong> HELLO
          </p>
        </div>
      </ThreadTimeline>
    </>
  ));
  const draft = screen.getByRole("textbox");
  draft.focus();
  const input = open();
  expect(screen.queryByText("Context info")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(input));
  fireEvent.input(input, { target: { value: "hello" } });
  await screen.findByText("1/3");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByText("2/3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다음 결과 (Enter)" }));
  expect(screen.getByText("3/3")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByText("1/3")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(screen.getByText("3/3")).toBeTruthy();
  fireEvent.keyDown(input, { key: "f", metaKey: true });
  await waitFor(() => expect(input.selectionEnd).toBe(5));
  const viewport = screen.getByRole("region");
  const top = viewport.scrollTop;
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("searchbox")).toBeNull();
  expect(document.activeElement).toBe(draft);
  expect(screen.getByText("Context info")).toBeTruthy();
  expect(viewport.scrollTop).toBe(top);
});

it("defers Korean IME input and disables navigation for no matches", async () => {
  render(() => (
    <ThreadTimeline active followKey="one">
      <div data-thread-search-root>
        <p>한글 한글</p>
      </div>
    </ThreadTimeline>
  ));
  const input = open();
  fireEvent.compositionStart(input);
  fireEvent.input(input, { target: { value: "한" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(screen.getByText("0/0")).toBeTruthy();
  fireEvent.compositionEnd(input, { target: { value: "한글" } });
  await screen.findByText("1/2");
  fireEvent.input(input, { target: { value: "missing" } });
  await screen.findByText("0/0");
  expect(
    (
      screen.getByRole("button", {
        name: "다음 결과 (Enter)",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("updates streaming and expanded content without moving the selected occurrence", async () => {
  const [body, setBody] = createSignal("needle needle");
  const [collapsed, setCollapsed] = createSignal(true);
  render(() => (
    <ThreadTimeline active followKey="one">
      <div data-thread-search-root>
        <p>{body()}</p>
      </div>
      <div data-thread-search-root data-thread-search-hidden={collapsed()}>
        <p>needle</p>
      </div>
    </ThreadTimeline>
  ));
  fireEvent.input(open(), { target: { value: "needle" } });
  await screen.findByText("1/2");
  fireEvent.keyDown(findInput(), { key: "Enter" });
  const viewport = screen.getByRole("region");
  const top = viewport.scrollTop;
  setBody("needle needle needle");
  await screen.findByText("2/3");
  expect(viewport.scrollTop).toBe(top);
  setCollapsed(false);
  await screen.findByText("2/4");
  setBody("needle");
  await screen.findByText("2/2");
});

it("accepts menu requests and resets when switching threads or leaving the page", async () => {
  const [request, setRequest] = createSignal(0);
  const [thread, setThread] = createSignal("one");
  const [active, setActive] = createSignal(true);
  render(() => (
    <ThreadTimeline
      active={active()}
      threadId={thread()}
      followKey={thread()}
      findRequest={request()}
    >
      <div data-thread-search-root>
        <p>needle</p>
      </div>
    </ThreadTimeline>
  ));
  setRequest(1);
  fireEvent.input(findInput(), { target: { value: "needle" } });
  await screen.findByText("1/1");
  setThread("two");
  expect(screen.queryByRole("searchbox")).toBeNull();
  expect(open().value).toBe("");
  setActive(false);
  expect(screen.queryByRole("searchbox")).toBeNull();
  fireEvent.keyDown(document, { key: "f", ctrlKey: true });
  expect(screen.queryByRole("searchbox")).toBeNull();
});

it("registers native highlights, recreates ranges after code token replacement, and cleans up", async () => {
  const registry = new Map();
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      priority = 0;
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  render(() => (
    <ThreadTimeline active followKey="one">
      <div data-thread-search-root>
        <pre>
          <code>needle needle</code>
        </pre>
      </div>
    </ThreadTimeline>
  ));
  fireEvent.input(open(), { target: { value: "needle" } });
  await screen.findByText("1/2");
  const old = registry.get("thread-find-all");
  expect(old.size).toBe(2);
  fireEvent.keyDown(findInput(), { key: "Enter" });
  const beforeReplacement = registry.get("thread-find-all");
  const code = document.querySelector("code") as HTMLElement;
  code.innerHTML = "<span>nee</span><span>dle needle</span>";
  await waitFor(() =>
    expect(registry.get("thread-find-all")).not.toBe(beforeReplacement),
  );
  expect(screen.getByText("2/2")).toBeTruthy();
  expect([...registry.get("thread-find-current")][0].toString()).toBe("needle");
  fireEvent.click(screen.getByRole("button", { name: "검색 닫기 (Esc)" }));
  expect(registry.size).toBe(0);
  open();
  await screen.findByText("1/2");
  cleanup();
  expect(registry.size).toBe(0);
});

it("keeps search position through new turns and resumes following only from the latest button", async () => {
  const observers: {
    targets: Element[];
    callback: (entries: ResizeObserverEntry[]) => void;
  }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: {
        targets: Element[];
        callback: (entries: ResizeObserverEntry[]) => void;
      };
      constructor(callback: (entries: ResizeObserverEntry[]) => void) {
        this.entry = { targets: [], callback };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const [turn, setTurn] = createSignal("one");
  render(() => (
    <ThreadTimeline
      active
      threadId="thread"
      followKey={turn()}
      bottomInset={180}
    >
      <div data-thread-search-root>
        <p>needle</p>
      </div>
    </ThreadTimeline>
  ));
  const viewport = screen.getByRole("region");
  let height = 2000;
  let top = 1400;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 600 },
    scrollHeight: { get: () => height },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.min(Math.max(0, value), height - 600);
      },
    },
  });
  const resize = () => {
    for (const observer of observers)
      if (observer.targets.includes(viewport))
        observer.callback([
          {
            target: viewport,
            contentRect: new DOMRect(0, 0, 500, 600),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          },
        ]);
  };
  fireEvent.input(open(), { target: { value: "needle" } });
  await screen.findByText("1/1");
  fireEvent.scroll(viewport);
  const position = top;
  height = 2400;
  resize();
  setTurn("two");
  expect(top).toBe(position);
  fireEvent.keyDown(findInput(), { key: "Escape" });
  expect(top).toBe(position);
  viewport.scrollTop = height - 600;
  fireEvent.scroll(viewport);
  height = 2600;
  resize();
  expect(top).toBe(1800);
  fireEvent.click(screen.getByRole("button", { name: "최신 내용으로 이동" }));
  expect(top).toBe(2000);
  height = 2800;
  resize();
  expect(top).toBe(2200);
});

it("repaints fallback highlights on nested scrolling and removes them on close", async () => {
  let rect = new DOMRect(30, 50, 60, 20);
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [rect],
  });
  const { container } = render(() => (
    <ThreadTimeline active followKey="one">
      <div data-thread-search-root>
        <pre style="overflow-x:auto">needle needle</pre>
      </div>
    </ThreadTimeline>
  ));
  const viewport = screen.getByRole("region");
  viewport.getBoundingClientRect = () => new DOMRect(10, 20, 500, 600);
  const pre = container.querySelector("pre") as HTMLElement;
  pre.getBoundingClientRect = () => new DOMRect(10, 20, 500, 100);
  fireEvent.input(open(), { target: { value: "needle" } });
  await screen.findByText("1/2");
  const painted = () =>
    container.querySelector(".bg-find-current\\/65") as HTMLElement | null;
  await waitFor(() => expect(painted()?.style.left).toBe("20px"));
  rect = new DOMRect(20, 50, 60, 20);
  fireEvent.scroll(pre);
  await waitFor(() => expect(painted()?.style.left).toBe("10px"));
  fireEvent.keyDown(findInput(), { key: "Escape" });
  expect(painted()).toBeNull();
});
