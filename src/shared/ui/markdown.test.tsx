import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { Markdown } from "./markdown";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
