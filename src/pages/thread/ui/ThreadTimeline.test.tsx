import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadTimeline } from "./ThreadTimeline";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  ["wheel", false],
  ["wheel", true],
  ["keyboard", false],
  ["keyboard", true],
  ["scrollbar", false],
  ["scrollbar", true],
])(
  "honors upward %s input during streaming (scroll delivered first: %s)",
  (input, scrollFirst) => {
    let resize!: () => void;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    render(() => <ThreadTimeline followKey="turn-1">Response</ThreadTimeline>);
    const viewport = screen.getByRole("region", { name: "스레드 타임라인" });
    let height = 1000;
    let top = 0;
    Object.defineProperties(viewport, {
      scrollHeight: { get: () => height },
      clientHeight: { get: () => 400 },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, height - 400));
        },
      },
    });
    resize();
    expect(top).toBe(600);
    if (input === "wheel") fireEvent.wheel(viewport, { deltaY: -1 });
    if (input === "keyboard") fireEvent.keyDown(viewport, { key: "ArrowUp" });
    // A queued scroll notification from the previous automatic scroll must not
    // resume following before the user's wheel movement is applied.
    fireEvent.scroll(viewport);
    viewport.scrollTop = 599;
    if (scrollFirst) fireEvent.scroll(viewport);
    height = 1100;
    resize();
    expect(top).toBe(599);
    fireEvent.scroll(viewport);
    height = 1200;
    resize();
    expect(top).toBe(599);
    fireEvent.click(screen.getByRole("button", { name: "최신 내용으로 이동" }));
    expect(top).toBe(800);
    height = 1300;
    resize();
    expect(top).toBe(900);
  },
);

it("follows growth, preserves reading position, and resumes from the latest button or a new turn", () => {
  let resize!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    },
  );
  const [key, setKey] = createSignal("thread:turn-1");
  render(() => <ThreadTimeline followKey={key()}>Response</ThreadTimeline>);
  const viewport = screen.getByRole("region", { name: "스레드 타임라인" });
  let height = 1000;
  let visible = 400;
  let top = 0;
  Object.defineProperties(viewport, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => visible },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - visible));
      },
    },
  });
  const latest = () =>
    screen.queryByRole("button", { name: "최신 내용으로 이동" });
  resize();
  expect(top).toBe(600);
  height = 1200;
  resize();
  expect(top).toBe(800);
  expect(latest()).toBeNull();

  viewport.scrollTop = 200;
  fireEvent.scroll(viewport);
  expect(latest()).not.toBeNull();
  height = 1400;
  resize();
  expect(top).toBe(200);
  fireEvent.click(screen.getByRole("button", { name: "최신 내용으로 이동" }));
  expect(top).toBe(1000);
  expect(latest()).toBeNull();
  height = 1600;
  resize();
  expect(top).toBe(1200);

  visible = 250; // Approval panel or window resize reduces the history viewport.
  resize();
  expect(top).toBe(1350);
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  setKey("thread:turn-2");
  expect(top).toBe(1350);
  expect(latest()).toBeNull();

  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  viewport.scrollTop = 1350;
  fireEvent.scroll(viewport);
  height = 1800;
  resize();
  expect(top).toBe(1550);
  expect(latest()).toBeNull();
  cleanup();
  expect(disconnect).toHaveBeenCalledOnce();
});
