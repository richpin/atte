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
  "data-code-block-index",
  "disabled",
  "href",
  "type",
] as const;

const codeLanguages = {
  bash: { id: "bash", label: "Shell" },
  c: { id: "c", label: "C" },
  cpp: { id: "cpp", label: "C++" },
  cs: { id: "csharp", label: "C#" },
  csharp: { id: "csharp", label: "C#" },
  css: { id: "css", label: "CSS" },
  diff: { id: "diff", label: "Diff" },
  go: { id: "go", label: "Go" },
  html: { id: "html", label: "HTML" },
  java: { id: "java", label: "Java" },
  javascript: { id: "javascript", label: "JavaScript" },
  js: { id: "javascript", label: "JavaScript" },
  json: { id: "json", label: "JSON" },
  jsx: { id: "jsx", label: "JSX" },
  kotlin: { id: "kotlin", label: "Kotlin" },
  markdown: { id: "markdown", label: "Markdown" },
  md: { id: "markdown", label: "Markdown" },
  python: { id: "python", label: "Python" },
  py: { id: "python", label: "Python" },
  ruby: { id: "ruby", label: "Ruby" },
  rust: { id: "rust", label: "Rust" },
  rs: { id: "rust", label: "Rust" },
  sh: { id: "bash", label: "Shell" },
  shell: { id: "bash", label: "Shell" },
  sql: { id: "sql", label: "SQL" },
  swift: { id: "swift", label: "Swift" },
  ts: { id: "typescript", label: "TypeScript" },
  tsx: { id: "tsx", label: "TSX" },
  typescript: { id: "typescript", label: "TypeScript" },
  xml: { id: "xml", label: "XML" },
  yaml: { id: "yaml", label: "YAML" },
  yml: { id: "yaml", label: "YAML" },
  zsh: { id: "bash", label: "Shell" },
} as const;

export type CodeLanguage = { id: string; label: string };
export type MarkdownCodeBlock = {
  source: string;
  language?: CodeLanguage;
};
export type RenderedMarkdown = {
  html: string;
  codeBlocks: MarkdownCodeBlock[];
};

let renderedCodeBlocks: MarkdownCodeBlock[] = [];

function normalizeCodeLanguage(value?: string): CodeLanguage | undefined {
  const name = value?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return name && Object.hasOwn(codeLanguages, name)
    ? codeLanguages[name as keyof typeof codeLanguages]
    : undefined;
}

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
    code({ text, lang }) {
      const index = renderedCodeBlocks.push({
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
