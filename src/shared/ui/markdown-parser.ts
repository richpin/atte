import DOMPurify from "dompurify";
import { Marked } from "marked";

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
  "disabled",
  "href",
  "type",
] as const;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  },
});

export function renderMarkdown(source: string) {
  const parsed = parser.parse(source, { async: false });
  if (typeof parsed !== "string") throw new Error("Async Markdown is disabled");
  return DOMPurify.sanitize(parsed, {
    ALLOWED_TAGS: [...allowedTags],
    ALLOWED_ATTR: [...allowedAttributes],
    ALLOW_DATA_ATTR: false,
  });
}
