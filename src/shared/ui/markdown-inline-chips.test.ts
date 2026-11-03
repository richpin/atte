import { expect, it } from "vitest";
import { prepareInlineChips } from "./markdown-inline-chips";
import { renderMarkdown } from "./markdown-parser";

it("preserves surrounding Markdown and renders only validated mention ranges", () => {
  const source = "**review** @src/a.ts and @literal";
  const prepared = prepareInlineChips(source, [
    { start: 11, end: 20, label: "@src/a.ts", title: "src/a.ts" },
    { start: 25, end: 33, label: "wrong", title: "literal" },
  ]);
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(prepared.source).html;
  prepared.decorate(root);
  expect(root.querySelector("strong")?.textContent).toBe("review");
  expect(root.querySelectorAll("[data-file-mention]")).toHaveLength(1);
  expect(root.querySelector("[data-file-mention]")?.textContent).toBe(
    "@src/a.ts",
  );
  expect(
    root.querySelector("[data-file-mention] svg[aria-hidden='true']"),
  ).toBeTruthy();
  expect(root.textContent).toContain("@literal");
});
