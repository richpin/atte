import morphdom from "morphdom";
import { createEffect, on, onCleanup } from "solid-js";
import { renderMarkdown } from "./markdown-parser";

const maximumFormattedSourceLength = 100_000;

export type MarkdownProps = {
  source: string;
  variant: "user" | "agent";
  streaming?: boolean;
  generation?: string;
};

export function Markdown(props: MarkdownProps) {
  let body!: HTMLDivElement;
  let disposed = false;
  let frame: number | undefined;
  let latestSource = "";
  let renderGeneration = 0;
  let sourceGeneration = props.generation;

  function decorateTables(target: HTMLElement) {
    for (const table of target.querySelectorAll<HTMLTableElement>("table")) {
      if (table.parentElement?.classList.contains("markdown-table")) continue;
      const wrapper = document.createElement("div");
      wrapper.className = "markdown-table max-w-full overflow-x-auto";
      wrapper.dataset.markdownTable = "";
      table.before(wrapper);
      wrapper.append(table);
    }
  }

  function cancelFrame() {
    if (frame === undefined) return;
    cancelAnimationFrame(frame);
    frame = undefined;
  }

  function showPlainText(source: string) {
    body.replaceChildren(document.createTextNode(source));
    body.dataset.fallback = "true";
  }

  function updateBody(source: string, generation: number) {
    if (disposed || generation !== renderGeneration) return;
    if (source.length > maximumFormattedSourceLength) {
      showPlainText(source);
      return;
    }

    try {
      const html = renderMarkdown(source);
      const next = document.createElement("div");
      next.innerHTML = html;
      decorateTables(next);
      if (disposed || generation !== renderGeneration) return;
      morphdom(body, next, { childrenOnly: true });
      delete body.dataset.fallback;
    } catch {
      showPlainText(source);
    }
  }

  function flush() {
    cancelFrame();
    updateBody(latestSource, renderGeneration);
  }

  function schedule() {
    if (frame !== undefined) return;
    const generation = renderGeneration;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      updateBody(latestSource, generation);
    });
  }

  createEffect(
    on(
      () => [props.source, props.streaming ?? false, props.generation] as const,
      ([source, streaming, generation], previous) => {
        latestSource = source;
        const changedGeneration = generation !== sourceGeneration;
        const becameTerminal = previous?.[1] === true && !streaming;
        if (!previous || changedGeneration || becameTerminal) {
          renderGeneration++;
          sourceGeneration = generation;
          flush();
          return;
        }
        if (streaming) schedule();
        else flush();
      },
    ),
  );

  onCleanup(() => {
    disposed = true;
    renderGeneration++;
    cancelFrame();
  });

  return (
    <div
      ref={body}
      data-markdown-body=""
      data-variant={props.variant}
      class="markdown-body min-w-0 max-w-full break-words"
    />
  );
}
