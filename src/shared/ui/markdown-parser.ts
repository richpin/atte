import DOMPurify from "dompurify";
import { Marked } from "marked";
import { type CodeLanguage, normalizeCodeLanguage } from "./code-languages";

const allowedTags = [
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
] as const;

const allowedAttributes = [
  "checked",
  "class",
  "data-code-block-index",
  "disabled",
  "href",
  "type",
] as const;

export type MarkdownCodeBlock = {
  source: string;
  language?: CodeLanguage;
  closed: boolean;
};
export type RenderedMarkdown = {
  html: string;
  codeBlocks: MarkdownCodeBlock[];
};

let renderedCodeBlocks: MarkdownCodeBlock[] = [];

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hasClosingFence(raw: string) {
  const lines = raw.split(/\r?\n/);
  const opening = lines[0]?.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!opening) return true;
  const marker = opening[1];
  if (!marker) return false;
  const closing = new RegExp(
    `^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`,
  );
  for (let index = lines.length - 1; index > 0; index--) {
    const line = lines[index];
    if (line && closing.test(line)) return true;
    if (line?.trim()) return false;
  }
  return false;
}

export function safeWebUrl(destination: string) {
  if (!/^https?:\/\//i.test(destination)) return undefined;
  try {
    const url = new URL(destination);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

const parser = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    heading({ tokens, depth }) {
      const level = Math.min(depth + 2, 6);
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      const destination = safeWebUrl(href);
      return destination
        ? `<a href="${escapeHtml(destination)}">${label}</a>`
        : label;
    },
    image({ href, text }) {
      const label = escapeHtml(text);
      const destination = safeWebUrl(href);
      const readableDestination = destination
        ? `<a href="${escapeHtml(destination)}">${escapeHtml(href)}</a>`
        : escapeHtml(href);
      return `${label}${label ? " " : ""}(${readableDestination})`;
    },
    code({ raw, text, lang }) {
      const index = renderedCodeBlocks.push({
        closed: hasClosingFence(raw),
        source: text,
        language: normalizeCodeLanguage(lang),
      });
      return `<pre data-code-block-index="${index - 1}"><code>${escapeHtml(text)}</code></pre>\n`;
    },
  },
});

export function renderMarkdown(source: string): RenderedMarkdown {
  renderedCodeBlocks = [];
  try {
    const parsed = parser.parse(source, { async: false });
    if (typeof parsed !== "string")
      throw new Error("Async Markdown is disabled");
    const html = DOMPurify.sanitize(parsed, {
      ALLOWED_TAGS: [...allowedTags],
      ALLOWED_ATTR: [...allowedAttributes],
      ALLOW_DATA_ATTR: false,
    });
    return { html, codeBlocks: renderedCodeBlocks };
  } finally {
    renderedCodeBlocks = [];
  }
}
