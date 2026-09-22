import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Markdown } from "./markdown";

let animationFrames: Map<number, FrameRequestCallback>;

function flushAnimationFrame() {
  const frames = [...animationFrames.values()];
  animationFrames.clear();
  for (const frame of frames) frame(performance.now());
}

beforeEach(() => {
  animationFrames = new Map();
  let nextAnimationFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrame++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps split Markdown constructs readable and converges when they complete", () => {
  const [source, setSource] = createSignal("Start **bo");
  const [streaming, setStreaming] = createSignal(true);
  const incremental = render(() => (
    <Markdown source={source()} variant="agent" streaming={streaming()} />
  ));
  const body = incremental.container.querySelector<HTMLElement>(
    "[data-markdown-body]",
  );

  expect(body?.textContent).toContain("**bo");

  setSource("Start **bold** and [li");
  flushAnimationFrame();
  expect(body?.querySelector("strong")?.textContent).toBe("bold");
  expect(body?.textContent).toContain("[li");

  setSource(`Start **bold** and [link](https://example.com)

| State |
| ---`);
  flushAnimationFrame();
  expect(body?.textContent).toContain("link");
  expect(body?.textContent).toContain("State");

  setSource(`Start **bold** and [link](https://example.com)

| State |
| --- |
| ready |

\`\`\`ts
const value = 1;`);
  flushAnimationFrame();
  expect(body?.querySelector("table")?.textContent).toContain("ready");
  expect(body?.querySelector("pre code")?.textContent).toContain(
    "const value = 1;",
  );

  const completeSource = `${source()}
\`\`\``;
  setSource(completeSource);
  setStreaming(false);
  const fresh = render(() => (
    <Markdown source={completeSource} variant="agent" streaming={false} />
  ));

  expect(body?.innerHTML).toBe(
    fresh.container.querySelector("[data-markdown-body]")?.innerHTML,
  );
  expect(animationFrames.size).toBe(0);
});
