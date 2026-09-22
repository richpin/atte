import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { Markdown } from "./markdown";

const highlightCode = vi.hoisted(() => vi.fn());

vi.mock("./syntax-highlighter", () => ({ highlightCode }));

let animationFrames: Map<number, FrameRequestCallback>;

function flushAnimationFrame() {
  const frames = [...animationFrames.values()];
  animationFrames.clear();
  for (const frame of frames) frame(performance.now());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  localStorage.setItem("atte.locale", "en");
  highlightCode.mockReset();
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
  localStorage.removeItem("atte.locale");
  vi.unstubAllGlobals();
});

it("keeps an open fence plain, then highlights it after the fence closes", async () => {
  const result = deferred<{
    tokens: { color?: string; content: string; fontStyle?: number }[][];
  }>();
  highlightCode.mockReturnValue(result.promise);
  const [source, setSource] = createSignal("```ts\nconst value = 1;");
  const { container } = render(() => (
    <Markdown source={source()} variant="agent" streaming />
  ));

  const plainCode = container.querySelector<HTMLElement>("pre code");
  expect(plainCode?.textContent).toBe("const value = 1;");
  expect(highlightCode).not.toHaveBeenCalled();

  setSource("```ts\nconst value = 1;\n```");
  flushAnimationFrame();

  expect(highlightCode).toHaveBeenCalledWith(
    "const value = 1;",
    "typescript",
    "light",
  );
  expect(container.querySelector("pre code")?.textContent).toBe(
    "const value = 1;",
  );
  expect(container.querySelector("[data-code-highlighted]")).toBeNull();

  result.resolve({
    tokens: [
      [
        { color: "#cf222e", content: "const", fontStyle: 1 },
        { content: " value = 1;" },
      ],
    ],
  });

  await waitFor(() =>
    expect(container.querySelector("[data-code-highlighted]")).toBeTruthy(),
  );
  expect(container.querySelector("pre code")?.textContent).toBe(
    "const value = 1;",
  );
  const token = container.querySelector<HTMLElement>("pre code span");
  expect(token?.style.color).toBe("rgb(207, 34, 46)");
  expect(token?.classList).toContain("italic");

  const fresh = render(() => (
    <Markdown
      source={`\`\`\`ts
const value = 1;
\`\`\``}
      variant="agent"
      streaming={false}
    />
  ));
  await waitFor(() =>
    expect(
      fresh.container.querySelector("[data-code-highlighted]"),
    ).toBeTruthy(),
  );
  expect(container.querySelector("[data-markdown-body]")?.innerHTML).toBe(
    fresh.container.querySelector("[data-markdown-body]")?.innerHTML,
  );
});

it("highlights an unfinished known fence when the turn completes", () => {
  highlightCode.mockReturnValue(new Promise(() => undefined));
  const [streaming, setStreaming] = createSignal(true);
  render(() => (
    <Markdown
      source={`\`\`\`python
print('done')`}
      variant="agent"
      streaming={streaming()}
    />
  ));

  expect(highlightCode).not.toHaveBeenCalled();
  setStreaming(false);
  expect(highlightCode).toHaveBeenCalledWith(
    "print('done')",
    "python",
    "light",
  );
});

it("keeps unknown-language source copyable inside the code layout", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const { container } = render(() => (
    <I18nProvider>
      <Markdown
        source={`\`\`\`unknown-runtime
plain();
\`\`\``}
        variant="agent"
        streaming={false}
      />
    </I18nProvider>
  ));

  expect(highlightCode).not.toHaveBeenCalled();
  const block = container.querySelector<HTMLElement>(
    "[data-markdown-code-block]",
  );
  expect(block?.querySelector("code")?.textContent).toBe("plain();");
  expect(block?.classList).toContain("max-w-full");
  expect(block?.querySelector("pre")?.classList).toContain("overflow-x-auto");
  await fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  expect(writeText).toHaveBeenCalledWith("plain();");
});

it("rejects a stale highlight result for an older exact source", async () => {
  const first = deferred<{ tokens: { color?: string; content: string }[][] }>();
  const second = deferred<{
    tokens: { color?: string; content: string }[][];
  }>();
  highlightCode
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const [source, setSource] = createSignal("```js\nconst oldValue = 1;\n```");
  const { container } = render(() => (
    <Markdown source={source()} variant="agent" streaming />
  ));

  setSource("```js\nconst currentValue = 2;\n```");
  flushAnimationFrame();
  first.resolve({
    tokens: [[{ color: "#111111", content: "STALE" }]],
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(container.querySelector("pre code")?.textContent).toBe(
    "const currentValue = 2;",
  );
  expect(container.textContent).not.toContain("STALE");

  second.resolve({
    tokens: [[{ color: "#222222", content: "const currentValue = 2;" }]],
  });
  await waitFor(() =>
    expect(container.querySelector("[data-code-highlighted]")).toBeTruthy(),
  );
  expect(container.querySelector("pre code")?.textContent).toBe(
    "const currentValue = 2;",
  );
});

it("keeps source, copy, and layout working when highlighting fails", async () => {
  highlightCode.mockRejectedValue(new Error("highlighter unavailable"));
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const source = "const safe = '<script>never markup</script>';";
  const { container } = render(() => (
    <I18nProvider>
      <Markdown
        source={`\`\`\`javascript\n${source}\n\`\`\``}
        variant="agent"
        streaming={false}
      />
    </I18nProvider>
  ));

  await Promise.resolve();
  await Promise.resolve();
  const block = container.querySelector<HTMLElement>(
    "[data-markdown-code-block]",
  );
  expect(block?.querySelector("code")?.textContent).toBe(source);
  expect(block?.querySelector("script")).toBeNull();
  expect(block?.classList).toContain("max-w-full");
  expect(block?.querySelector("pre")?.classList).toContain("overflow-x-auto");

  await fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  expect(writeText).toHaveBeenCalledWith(source);
});

it("ignores highlighting that finishes after component disposal", async () => {
  const result = deferred<{
    tokens: { color?: string; content: string }[][];
  }>();
  highlightCode.mockReturnValue(result.promise);
  const { container, unmount } = render(() => (
    <Markdown
      source={`\`\`\`rust
fn main() {}
\`\`\``}
      variant="agent"
      streaming={false}
    />
  ));
  const code = container.querySelector("code");

  unmount();
  result.resolve({ tokens: [[{ color: "#111111", content: "mutated" }]] });
  await Promise.resolve();
  await Promise.resolve();

  expect(code?.textContent).toBe("fn main() {}");
});
