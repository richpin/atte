import { cleanup, render } from "@solidjs/testing-library";
import DOMPurify from "dompurify";
import morphdom from "morphdom";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { Markdown } from "./markdown";
import * as markdownParser from "./markdown-parser";

vi.mock("morphdom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("morphdom")>();
  return { default: vi.fn(actual.default) };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function expectCompletePlainText(source: string) {
  const { container } = render(() => (
    <Markdown source={source} variant="agent" streaming={false} />
  ));
  const body = container.querySelector<HTMLElement>("[data-markdown-body]");
  expect(body?.dataset.fallback).toBe("true");
  expect(body?.textContent).toBe(source);
  expect(body?.querySelector("strong, script")).toBeNull();
}

it("falls back to the complete plain source when parsing fails", () => {
  vi.spyOn(markdownParser, "renderMarkdown").mockImplementationOnce(() => {
    throw new Error("parse failed");
  });
  expectCompletePlainText("**parser source** <script>safe</script>");
});

it("falls back to the complete plain source when sanitizing fails", () => {
  vi.spyOn(DOMPurify, "sanitize").mockImplementationOnce(() => {
    throw new Error("sanitize failed");
  });
  expectCompletePlainText("**sanitizer source** <script>safe</script>");
});

it("replaces a partially reconciled body with the complete plain source", () => {
  const [source, setSource] = createSignal("Initial **safe** source");
  const { container } = render(() => (
    <Markdown source={source()} variant="agent" streaming={false} />
  ));
  const body = container.querySelector<HTMLElement>("[data-markdown-body]");
  vi.mocked(morphdom).mockImplementationOnce((fromNode) => {
    (fromNode as HTMLElement).append(document.createElement("script"));
    throw new Error("morph failed");
  });

  const failedSource = "Complete **fallback** source";
  setSource(failedSource);

  expect(body?.dataset.fallback).toBe("true");
  expect(body?.textContent).toBe(failedSource);
  expect(body?.querySelector("strong, script")).toBeNull();
});
