export type ThreadSearchMatch = {
  block: Element;
  start: number;
  range: Range;
};

const excluded =
  'button, summary, svg, script, style, [hidden], [inert], [aria-hidden="true"], .sr-only, [data-thread-search-hidden="true"], [data-thread-search-ignore], [data-code-language], [data-code-copy-feedback]';
const blocks = "p, pre, li, td, th, h1, h2, h3, h4, h5, h6, div";

/** Search rendered text, retaining offsets across inline markup and code tokens. */
export function findThreadMatches(root: HTMLElement, query: string) {
  const matches: ThreadSearchMatch[] = [];
  if (!query) return matches;
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );

  for (const scope of root.querySelectorAll<HTMLElement>(
    "[data-thread-search-root]",
  )) {
    if (scope.closest(excluded)) continue;
    let block: Element | undefined;
    let nodes: { node: Text; start: number }[] = [];
    let text = "";
    function flush() {
      if (block && text) {
        pattern.lastIndex = 0;
        let firstIndex = 0;
        let lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const start = match.index;
          const end = start + match[0].length;
          while (
            firstIndex < nodes.length - 1 &&
            start >= nodes[firstIndex].start + nodes[firstIndex].node.length
          )
            firstIndex++;
          lastIndex = Math.max(firstIndex, lastIndex);
          while (
            lastIndex < nodes.length - 1 &&
            end > nodes[lastIndex].start + nodes[lastIndex].node.length
          )
            lastIndex++;
          const first = nodes[firstIndex];
          const last = nodes[lastIndex];
          const range = document.createRange();
          range.setStart(first.node, start - first.start);
          range.setEnd(last.node, end - last.start);
          matches.push({ block, start, range });
        }
      }
      nodes = [];
      text = "";
      block = undefined;
    }
    function visit(node: Node) {
      if (node instanceof Element) {
        const style = getComputedStyle(node);
        if (
          node.matches(excluded) ||
          style.display === "none" ||
          style.visibility === "hidden"
        ) {
          flush();
          return;
        }
        if (node.tagName === "BR") {
          flush();
          return;
        }
        if (node.tagName === "DETAILS" && !node.hasAttribute("open")) {
          flush();
          return;
        }
      }
      if (node instanceof Text) {
        const parent = node.parentElement;
        if (!parent) return;
        const pre = parent.closest("pre");
        const nextBlock =
          (pre && scope.contains(pre) ? pre : parent.closest(blocks)) ?? scope;
        if (nextBlock !== block) flush();
        block = nextBlock;
        nodes.push({ node, start: text.length });
        text += node.data;
      } else {
        for (const child of node.childNodes) visit(child);
      }
    }
    visit(scope);
    flush();
  }
  return matches;
}

export function revealThreadMatch(
  match: ThreadSearchMatch,
  viewport: HTMLElement,
  bottomInset: number,
  topInset: number,
) {
  match.range.startContainer.parentElement
    ?.closest("[data-user-message-content]")
    ?.dispatchEvent(new Event("thread-search-reveal"));

  // Scroll nested code, table and tool output containers before the timeline.
  let parent = match.range.startContainer.parentElement;
  while (parent && parent !== viewport) {
    const style = getComputedStyle(parent);
    const rect = match.range.getBoundingClientRect();
    const bounds = parent.getBoundingClientRect();
    if (/(auto|scroll)/.test(style.overflowX)) {
      if (rect.left < bounds.left || rect.right > bounds.right)
        parent.scrollLeft += rect.left - bounds.left - parent.clientWidth / 2;
    }
    if (/(auto|scroll)/.test(style.overflowY)) {
      if (rect.top < bounds.top || rect.bottom > bounds.bottom)
        parent.scrollTop += rect.top - bounds.top - parent.clientHeight / 2;
    }
    parent = parent.parentElement;
  }
  const rect = match.range.getBoundingClientRect();
  const bounds = viewport.getBoundingClientRect();
  const available = Math.max(0, viewport.clientHeight - bottomInset - topInset);
  viewport.scrollTop += rect.top - bounds.top - topInset - available / 2;
}

export type SearchRectangle = {
  left: number;
  top: number;
  width: number;
  height: number;
  current: boolean;
};

/** Clip fallback rectangles to every nested scroll container and the viewport. */
export function threadMatchRectangles(
  matches: ThreadSearchMatch[],
  current: number,
  viewport: HTMLElement,
): SearchRectangle[] {
  const bounds = viewport.getBoundingClientRect();
  return matches.flatMap((match, index) => {
    let left = bounds.left;
    let right = bounds.right;
    let top = bounds.top;
    let bottom = bounds.bottom;
    let parent = match.range.startContainer.parentElement;
    while (parent && parent !== viewport) {
      const style = getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, rect.left);
        right = Math.min(right, rect.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, rect.top);
        bottom = Math.min(bottom, rect.bottom);
      }
      parent = parent.parentElement;
    }
    return Array.from(match.range.getClientRects()).flatMap((rect) => {
      const x = Math.max(left, rect.left);
      const y = Math.max(top, rect.top);
      const width = Math.min(right, rect.right) - x;
      const height = Math.min(bottom, rect.bottom) - y;
      return width > 0 && height > 0
        ? [
            {
              left: x - bounds.left,
              top: y - bounds.top,
              width,
              height,
              current: index === current,
            },
          ]
        : [];
    });
  });
}
