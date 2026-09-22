import { createEffect, on } from "solid-js";
import { renderMarkdown } from "./markdown-parser";

export type MarkdownProps = {
  source: string;
  variant: "user" | "agent";
};

export function Markdown(props: MarkdownProps) {
  let body!: HTMLDivElement;

  function decorateTables() {
    for (const table of body.querySelectorAll<HTMLTableElement>("table")) {
      if (table.parentElement?.classList.contains("markdown-table")) continue;
      const wrapper = document.createElement("div");
      wrapper.className = "markdown-table max-w-full overflow-x-auto";
      wrapper.dataset.markdownTable = "";
      table.before(wrapper);
      wrapper.append(table);
    }
  }

  createEffect(
    on(
      () => props.source,
      (source) => {
        try {
          const html = renderMarkdown(source);
          const next = document.createElement("div");
          next.innerHTML = html;
          body.replaceChildren(...next.childNodes);
          decorateTables();
          delete body.dataset.fallback;
        } catch {
          body.replaceChildren(document.createTextNode(source));
          body.dataset.fallback = "true";
        }
      },
    ),
  );

  return (
    <div
      ref={body}
      data-markdown-body=""
      data-variant={props.variant}
      class="markdown-body min-w-0 max-w-full break-words"
    />
  );
}
