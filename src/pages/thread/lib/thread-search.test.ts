import { afterEach, describe, expect, it } from "vitest";
import {
  findThreadMatches,
  revealThreadMatch,
  threadMatchRectangles,
} from "./thread-search";

afterEach(() => document.body.replaceChildren());

function content(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe("rendered conversation search", () => {
  it("counts occurrences across inline Markdown and syntax tokens, without crossing blocks", () => {
    const root = content(`<div data-thread-search-root>
      <p>Hel<strong>lo</strong> HELLO hello</p>
      <pre><code><span>hel</span><span>lo</span></code></pre>
      <p>hel</p><p>lo</p><p>hel<br>lo</p>
    </div><div data-thread-search-root><p>hello</p></div>`);
    const matches = findThreadMatches(root, "hello");
    expect(matches.map((match) => match.range.toString())).toEqual([
      "Hello",
      "HELLO",
      "hello",
      "hello",
      "hello",
    ]);
    expect(matches[0].start).toBe(0);
    expect(matches[1].start).toBe(6);
    expect(findThreadMatches(root, "")).toEqual([]);
  });

  it("keeps literal queries and Unicode offsets intact", () => {
    const root = content(
      "<div data-thread-search-root><p>İ 한글 😀 [a.*] 한<strong>글</strong></p></div>",
    );
    const matches = findThreadMatches(root, "한글");
    expect(matches.map((match) => match.range.toString())).toEqual([
      "한글",
      "한글",
    ]);
    expect(findThreadMatches(root, "[a.*]")[0].range.toString()).toBe("[a.*]");
    expect(findThreadMatches(root, "😀")[0].range.toString()).toBe("😀");
  });

  it("excludes controls, collapsed content and surrounding application UI", () => {
    const root = content(`<p>needle</p><div data-thread-search-root>
      <p>needle<button>needle</button><span class="sr-only">needle</span></p>
      <p hidden>needle</p><p style="display:none">needle</p>
      <span data-code-language="text">needle</span>
      <details><summary>needle</summary><pre>needle</pre></details>
      <details open><summary>needle</summary><pre>needle</pre></details>
    </div><div data-thread-search-root data-thread-search-hidden="true"><p>needle</p></div>`);
    expect(findThreadMatches(root, "needle")).toHaveLength(2);
    root
      .querySelector("[data-thread-search-hidden]")
      ?.setAttribute("data-thread-search-hidden", "false");
    expect(findThreadMatches(root, "needle")).toHaveLength(3);
  });

  it("reveals a clipped user message and scrolls nested code and the timeline", () => {
    const root = content(
      '<div data-thread-search-root data-user-message-content><pre style="overflow-x:auto;overflow-y:auto">needle</pre></div>',
    );
    const match = findThreadMatches(root, "needle")[0];
    let revealed = false;
    root.firstElementChild?.addEventListener("thread-search-reveal", () => {
      revealed = true;
    });
    const pre = root.querySelector("pre") as HTMLElement;
    Object.defineProperties(root, { clientHeight: { value: 600 } });
    Object.defineProperties(pre, {
      clientWidth: { value: 100 },
      clientHeight: { value: 100 },
    });
    root.getBoundingClientRect = () => new DOMRect(0, 0, 500, 600);
    pre.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
    match.range.getBoundingClientRect = () => new DOMRect(300, 400, 30, 20);
    revealThreadMatch(match, root, 180, 60);
    expect(revealed).toBe(true);
    expect(pre.scrollLeft).toBe(250);
    expect(pre.scrollTop).toBe(350);
    expect(root.scrollTop).toBe(160);
  });

  it("clips fallback highlights to nested scroll containers", () => {
    const root = content(
      '<div data-thread-search-root><pre style="overflow-x:auto;overflow-y:auto">needle</pre></div>',
    );
    const matches = findThreadMatches(root, "needle");
    root.getBoundingClientRect = () => new DOMRect(10, 20, 300, 200);
    const pre = root.querySelector("pre") as HTMLElement;
    pre.getBoundingClientRect = () => new DOMRect(40, 50, 100, 60);
    matches[0].range.getClientRects = () =>
      [new DOMRect(30, 40, 200, 30)] as unknown as DOMRectList;
    expect(threadMatchRectangles(matches, 0, root)).toEqual([
      { left: 30, top: 30, width: 100, height: 20, current: true },
    ]);
  });
});
