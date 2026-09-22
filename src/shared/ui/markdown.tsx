import { openUrl } from "@tauri-apps/plugin-opener";
import morphdom from "morphdom";
import { createEffect, on, onCleanup } from "solid-js";
import { useI18n } from "../i18n";
import { renderMarkdown, safeWebUrl } from "./markdown-parser";
import { type HighlightedCode, highlightCode } from "./syntax-highlighter";

const maximumFormattedSourceLength = 100_000;
const copyFeedbackDuration = 2_000;

export type MarkdownProps = {
  source: string;
  variant: "user" | "agent";
  streaming?: boolean;
  generation?: string;
};

export function Markdown(props: MarkdownProps) {
  const { locale, t } = useI18n();
  let body!: HTMLDivElement;
  let disposed = false;
  let frame: number | undefined;
  let latestSource = "";
  let renderGeneration = 0;
  let sourceGeneration: string | undefined;
  let codeSources: string[] = [];
  let copyRequest = 0;
  const copyRequests = new WeakMap<HTMLElement, number>();
  const feedbackTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const highlightTargets = new WeakMap<HTMLElement, string>();

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

  function copyButton(index: number) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.codeCopy = String(index);
    button.className =
      "markdown-code-copy rounded px-2 py-1 text-xs font-medium hover:bg-current/10 focus-visible:outline-2 focus-visible:outline-offset-2";
    button.setAttribute("aria-label", t("markdown.code.copy"));
    button.textContent = t("markdown.code.copyVisual");
    return button;
  }

  function decorateCodeBlocks(
    target: HTMLElement,
    blocks: ReturnType<typeof renderMarkdown>["codeBlocks"],
  ) {
    for (const pre of target.querySelectorAll<HTMLPreElement>(
      "pre[data-code-block-index]",
    )) {
      const index = Number(pre.dataset.codeBlockIndex);
      const block = blocks[index];
      if (!block) continue;

      const wrapper = document.createElement("div");
      wrapper.dataset.markdownCodeBlock = "";
      wrapper.className =
        "markdown-code-block my-3 min-w-0 max-w-full overflow-hidden rounded-lg border border-line";

      const header = document.createElement("div");
      header.className =
        "markdown-code-header flex min-h-9 items-center justify-between gap-3 border-line border-b px-2";
      if (block.language) {
        const language = document.createElement("span");
        language.dataset.codeLanguage = block.language.id;
        language.className = "truncate px-1 text-xs text-muted";
        language.textContent = block.language.label;
        header.append(language);
      } else {
        header.append(document.createElement("span"));
      }
      header.append(copyButton(index));

      const feedback = document.createElement("span");
      feedback.dataset.codeCopyFeedback = "";
      feedback.setAttribute("role", "status");
      feedback.setAttribute("aria-live", "polite");
      feedback.className = "sr-only";

      pre.before(wrapper);
      pre.className = "min-w-0 max-w-full overflow-x-auto p-3";
      delete pre.dataset.codeBlockIndex;
      wrapper.append(header, pre, feedback);
    }
  }

  function appendHighlightedCode(code: HTMLElement, result: HighlightedCode) {
    const fragment = document.createDocumentFragment();
    for (const [lineIndex, line] of result.tokens.entries()) {
      for (const token of line) {
        const span = document.createElement("span");
        span.textContent = token.content;
        if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(token.color ?? "")) {
          span.style.color = token.color ?? "";
        }
        if (token.fontStyle !== undefined && token.fontStyle >= 0) {
          if (token.fontStyle & 1) span.classList.add("italic");
          if (token.fontStyle & 2) span.classList.add("font-bold");
          if (token.fontStyle & 4) span.classList.add("underline");
        }
        fragment.append(span);
      }
      if (lineIndex < result.tokens.length - 1) fragment.append("\n");
    }
    code.replaceChildren(fragment);
  }

  function highlightCodeBlocks(
    blocks: ReturnType<typeof renderMarkdown>["codeBlocks"],
    streaming: boolean,
  ) {
    const wrappers = body.querySelectorAll<HTMLElement>(
      "[data-markdown-code-block]",
    );
    for (const [index, block] of blocks.entries()) {
      const code = wrappers[index]?.querySelector<HTMLElement>("pre code");
      if (!code) continue;
      highlightTargets.set(code, "");
      if (!block.language || (streaming && !block.closed)) continue;

      const appearance = props.variant === "user" ? "dark" : "light";
      const language = block.language.id;
      const key = `${appearance}\0${language}\0${block.source}`;
      highlightTargets.set(code, key);
      void highlightCode(block.source, language, appearance)
        .then((result) => {
          if (
            disposed ||
            !body.contains(code) ||
            highlightTargets.get(code) !== key
          )
            return;
          appendHighlightedCode(code, result);
          code.dataset.codeHighlighted = language;
        })
        .catch(() => undefined);
    }
  }

  function cancelFrame() {
    if (frame === undefined) return;
    cancelAnimationFrame(frame);
    frame = undefined;
  }

  function showPlainText(source: string) {
    codeSources = [];
    body.replaceChildren(document.createTextNode(source));
    body.dataset.fallback = "true";
  }

  function updateBody(source: string, generation: number, streaming: boolean) {
    if (disposed || generation !== renderGeneration) return;
    if (source.length > maximumFormattedSourceLength) {
      showPlainText(source);
      return;
    }

    try {
      const rendered = renderMarkdown(source);
      const next = document.createElement("div");
      next.innerHTML = rendered.html;
      decorateTables(next);
      decorateCodeBlocks(next, rendered.codeBlocks);
      if (disposed || generation !== renderGeneration) return;
      morphdom(body, next, { childrenOnly: true });
      codeSources = rendered.codeBlocks.map((block) => block.source);
      delete body.dataset.fallback;
      highlightCodeBlocks(rendered.codeBlocks, streaming);
    } catch {
      showPlainText(source);
    }
  }

  function flush() {
    cancelFrame();
    updateBody(latestSource, renderGeneration, props.streaming ?? false);
  }

  function schedule() {
    if (frame !== undefined) return;
    const generation = renderGeneration;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      updateBody(latestSource, generation, props.streaming ?? false);
    });
  }

  function activatedLink(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) return undefined;
    const link = target.closest<HTMLAnchorElement>("a[href]");
    return link && body.contains(link) ? link : undefined;
  }

  function openLink(event: Event) {
    const link = activatedLink(event);
    const destination = link && safeWebUrl(link.getAttribute("href") ?? "");
    if (!destination) return;
    event.preventDefault();
    void openUrl(destination).catch(() => undefined);
  }

  function openLinkFromKeyboard(event: KeyboardEvent) {
    if (event.key === "Enter") openLink(event);
  }

  function resetCopyFeedback(block: HTMLElement) {
    const timer = feedbackTimers.get(block);
    if (timer !== undefined) clearTimeout(timer);
    feedbackTimers.delete(block);
    const button = block.querySelector<HTMLButtonElement>("[data-code-copy]");
    const feedback = block.querySelector<HTMLElement>(
      "[data-code-copy-feedback]",
    );
    if (button) {
      button.setAttribute("aria-label", t("markdown.code.copy"));
      button.textContent = t("markdown.code.copyVisual");
    }
    if (feedback) {
      feedback.textContent = "";
      feedback.className = "sr-only";
    }
  }

  function showCopyFeedback(block: HTMLElement, copied: boolean) {
    resetCopyFeedback(block);
    const button = block.querySelector<HTMLButtonElement>("[data-code-copy]");
    const feedback = block.querySelector<HTMLElement>(
      "[data-code-copy-feedback]",
    );
    if (!button || !feedback) return;

    if (copied) {
      button.setAttribute("aria-label", t("markdown.code.copied"));
      button.textContent = t("markdown.code.copiedVisual");
      feedback.textContent = t("markdown.code.copiedAnnouncement");
    } else {
      feedback.textContent = t("markdown.code.copyFailed");
      feedback.className =
        "markdown-code-feedback px-3 py-2 text-xs text-danger";
    }
    feedbackTimers.set(
      block,
      setTimeout(() => resetCopyFeedback(block), copyFeedbackDuration),
    );
  }

  function isCurrentCopyRequest(block: HTMLElement, request: number) {
    return (
      !disposed && copyRequests.get(block) === request && body.contains(block)
    );
  }

  async function copyCode(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("button[data-code-copy]");
    const block = button?.closest<HTMLElement>("[data-markdown-code-block]");
    if (!button || !block || !body.contains(block)) return;
    const source = codeSources[Number(button.dataset.codeCopy)];
    if (source === undefined) return;

    resetCopyFeedback(block);
    const request = ++copyRequest;
    copyRequests.set(block, request);
    try {
      await navigator.clipboard.writeText(source);
      if (isCurrentCopyRequest(block, request)) showCopyFeedback(block, true);
    } catch {
      if (isCurrentCopyRequest(block, request)) showCopyFeedback(block, false);
    }
  }

  function handleBodyClick(event: Event) {
    void copyCode(event);
    openLink(event);
  }

  createEffect(
    on(
      () =>
        [
          props.source,
          props.streaming ?? false,
          props.generation,
          locale(),
        ] as const,
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
    for (const timer of feedbackTimers.values()) clearTimeout(timer);
    feedbackTimers.clear();
  });

  return (
    <div
      ref={body}
      on:click={handleBodyClick}
      on:keydown={openLinkFromKeyboard}
      data-markdown-body=""
      data-variant={props.variant}
      class="markdown-body min-w-0 max-w-full break-words"
    />
  );
}
