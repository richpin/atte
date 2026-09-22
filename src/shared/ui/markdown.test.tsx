import { cleanup, render, screen } from "@solidjs/testing-library";
import { batch, createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Markdown } from "./markdown";

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

let animationFrames: Map<number, FrameRequestCallback>;
let nextAnimationFrame: number;

function flushAnimationFrame() {
  const frames = [...animationFrames.values()];
  animationFrames.clear();
  for (const frame of frames) frame(performance.now());
}

beforeEach(() => {
  openUrl.mockClear();
  animationFrames = new Map();
  nextAnimationFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrame++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames.delete(id);
  });
});

it("activates only absolute HTTP and HTTPS Markdown links", () => {
  const { container } = render(() => (
    <Markdown
      source={`[Secure](https://example.com/docs)
[Plain HTTP](http://example.com)
[Script](javascript:alert(1))
[Data](data:text/plain,hello)
[File](file:///tmp/secret)
[Command](command:run)
[Relative](../docs)
[Custom](atte://thread/1)`}
      variant="agent"
    />
  ));

  const links = container.querySelectorAll<HTMLAnchorElement>("a");
  expect([...links].map((link) => link.textContent)).toEqual([
    "Secure",
    "Plain HTTP",
  ]);
  expect([...links].map((link) => link.getAttribute("href"))).toEqual([
    "https://example.com/docs",
    "http://example.com/",
  ]);
  for (const label of [
    "Script",
    "Data",
    "File",
    "Command",
    "Relative",
    "Custom",
  ]) {
    expect(container.textContent).toContain(label);
  }
});

it("opens links through the system browser without WebView navigation", () => {
  render(() => (
    <Markdown
      source="[Pointer](https://example.com/pointer) and [Keyboard](http://example.com/keyboard)"
      variant="agent"
    />
  ));
  const pointerLink = screen.getByRole("link", { name: "Pointer" });
  const pointerEvent = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });

  expect(pointerLink.dispatchEvent(pointerEvent)).toBe(false);
  expect(pointerEvent.defaultPrevented).toBe(true);
  expect(openUrl).toHaveBeenCalledWith("https://example.com/pointer");

  const keyboardLink = screen.getByRole("link", { name: "Keyboard" });
  keyboardLink.focus();
  const keyboardEvent = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });

  expect(keyboardLink.dispatchEvent(keyboardEvent)).toBe(false);
  expect(keyboardEvent.defaultPrevented).toBe(true);
  expect(openUrl).toHaveBeenCalledWith("http://example.com/keyboard");
});

it("renders Markdown images as readable links without loading resources", () => {
  const { container } = render(() => (
    <Markdown
      source={`![Architecture diagram](https://images.example.com/diagram.png)
![Local secret](file:///tmp/secret.png)`}
      variant="agent"
    />
  ));

  expect(container.textContent).toContain("Architecture diagram");
  expect(container.textContent).toContain(
    "https://images.example.com/diagram.png",
  );
  expect(container.textContent).toContain("Local secret");
  expect(container.textContent).toContain("file:///tmp/secret.png");
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    "https://images.example.com/diagram.png",
  );
  expect(
    container.querySelector(
      "img, source, video, audio, iframe, object, embed, [src], [srcset]",
    ),
  ).toBeNull();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders chat Markdown with semantic CommonMark and GFM structure", () => {
  const { container } = render(() => (
    <Markdown
      source={`# Local heading
First line
second line with **importance**, ~~old text~~, and \`code\`.

> A quote

- one
- two

| Name | State |
| --- | --- |
| Atte | ready |

- [x] shipped
- [ ] next`}
      variant="agent"
    />
  ));

  expect(
    screen.getByRole("heading", { name: "Local heading", level: 3 }),
  ).toBeTruthy();
  expect(container.querySelector("p br")).toBeTruthy();
  expect(container.querySelector("strong")?.textContent).toBe("importance");
  expect(container.querySelector("del")?.textContent).toBe("old text");
  expect(container.querySelector("code")?.textContent).toBe("code");
  expect(container.querySelector("blockquote")?.textContent).toContain(
    "A quote",
  );
  expect(container.querySelectorAll("ul > li")).toHaveLength(4);
  expect(container.querySelector("table")?.textContent).toContain("Atte");
  expect(container.querySelector("[data-markdown-table]")?.classList).toContain(
    "overflow-x-auto",
  );
  const tasks = container.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  expect(tasks).toHaveLength(2);
  expect([...tasks].every((task) => task.disabled)).toBe(true);
  expect(tasks[0]?.checked).toBe(true);
});

it("shows raw HTML literally and excludes active or styled HTML", () => {
  const source = `<script>alert(1)</script>
<iframe src="https://attacker.test"></iframe>
<form><input name="secret"></form>
<span style="color:red" onclick="alert(1)">unsafe</span>`;
  const { container } = render(() => (
    <Markdown source={source} variant="agent" />
  ));

  expect(container.textContent).toContain("<script>alert(1)</script>");
  expect(container.textContent).toContain(
    '<iframe src="https://attacker.test"></iframe>',
  );
  expect(container.textContent).toContain('<form><input name="secret"></form>');
  expect(container.textContent).toContain(
    '<span style="color:red" onclick="alert(1)">unsafe</span>',
  );
  expect(
    container.querySelector("script, iframe, form, [style], [onclick]"),
  ).toBeNull();
});

it("keeps plain text and malformed Markdown readable", () => {
  const source = "Plain first line\nunfinished **emphasis and [link](";
  const { container } = render(() => (
    <Markdown source={source} variant="agent" />
  ));
  const body = container.querySelector<HTMLElement>("[data-markdown-body]");

  expect(body?.textContent).toContain("Plain first line");
  expect(body?.textContent).toContain("unfinished **emphasis and [link](");
});

it("falls back to the complete plain source when rendering fails", () => {
  const [source, setSource] = createSignal("Initial text");
  const { container } = render(() => (
    <Markdown source={source()} variant="agent" />
  ));
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
    if (tagName === "div") throw new Error("DOM construction failed");
    return createElement(tagName, options);
  });

  const failedSource = "<script>still readable</script> **without loss**";
  setSource(failedSource);
  const body = container.querySelector<HTMLElement>("[data-markdown-body]");
  expect(body?.dataset.fallback).toBe("true");
  expect(body?.textContent).toBe(failedSource);
  expect(body?.querySelector("script, strong")).toBeNull();
});

it("coalesces streaming source updates into one render per animation frame", () => {
  const [source, setSource] = createSignal("Initial");
  const { container } = render(() => (
    <Markdown source={source()} variant="agent" streaming />
  ));
  const body = container.querySelector<HTMLElement>("[data-markdown-body]");

  setSource("Initial one");
  setSource("Initial one two");
  setSource("Initial one two **three**");

  expect(body?.textContent?.trim()).toBe("Initial");
  expect(animationFrames.size).toBe(1);

  flushAnimationFrame();

  expect(body?.textContent?.trim()).toBe("Initial one two three");
});

it("flushes the latest source immediately when streaming becomes terminal", () => {
  const [source, setSource] = createSignal("Initial");
  const [streaming, setStreaming] = createSignal(true);
  const { container } = render(() => (
    <Markdown source={source()} variant="agent" streaming={streaming()} />
  ));
  const body = container.querySelector<HTMLElement>("[data-markdown-body]");

  setSource("Final **source**");
  expect(body?.textContent?.trim()).toBe("Initial");
  expect(animationFrames.size).toBe(1);

  setStreaming(false);

  expect(body?.textContent?.trim()).toBe("Final source");
  expect(body?.querySelector("strong")?.textContent).toBe("source");
  expect(animationFrames.size).toBe(0);
});

it("preserves unchanged DOM nodes across a streaming append", () => {
  const [source, setSource] = createSignal("Stable paragraph");
  const { container } = render(() => (
    <Markdown source={source()} variant="agent" streaming />
  ));
  const body = container.querySelector<HTMLElement>("[data-markdown-body]");
  const paragraph = body?.querySelector("p");

  setSource("Stable paragraph grows");
  flushAnimationFrame();

  expect(body?.querySelector("p")).toBe(paragraph);
  expect(paragraph?.textContent).toBe("Stable paragraph grows");
});

it("converges to a fresh render after non-append structural changes", () => {
  const [source, setSource] = createSignal("Paragraph\n\n- first\n- second");
  const incremental = render(() => (
    <Markdown source={source()} variant="agent" streaming />
  ));
  const current = incremental.container.querySelector<HTMLElement>(
    "[data-markdown-body]",
  );

  const latest =
    "## Revised\n\n1. first\n2. second\n\n| State |\n| --- |\n| done |";
  setSource(latest);
  flushAnimationFrame();
  const fresh = render(() => (
    <Markdown source={latest} variant="agent" streaming={false} />
  ));

  expect(current?.innerHTML).toBe(
    fresh.container.querySelector("[data-markdown-body]")?.innerHTML,
  );
});

it("cancels pending work and rejects a stale frame from an older generation", () => {
  const [source, setSource] = createSignal("Turn one");
  const [generation, setGeneration] = createSignal("turn-1");
  const { container, unmount } = render(() => (
    <Markdown
      source={source()}
      variant="agent"
      streaming
      generation={generation()}
    />
  ));
  const body = container.querySelector<HTMLElement>("[data-markdown-body]");

  setSource("Stale turn one");
  const staleFrame = [...animationFrames.values()][0];
  batch(() => {
    setGeneration("turn-2");
    setSource("Fresh turn two");
  });
  expect(body?.textContent?.trim()).toBe("Fresh turn two");

  staleFrame?.(performance.now());
  expect(body?.textContent?.trim()).toBe("Fresh turn two");

  setSource("Pending turn two");
  expect(animationFrames.size).toBe(1);
  unmount();
  expect(animationFrames.size).toBe(0);
});

it("shows the complete source as plain text above the rendering safety limit", () => {
  const source = `**${"a".repeat(100_001)}**`;
  const { container } = render(() => (
    <Markdown source={source} variant="agent" streaming={false} />
  ));
  const body = container.querySelector<HTMLElement>("[data-markdown-body]");

  expect(body?.dataset.fallback).toBe("true");
  expect(body?.textContent).toBe(source);
  expect(body?.querySelector("strong")).toBeNull();
});
