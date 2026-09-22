import type { LanguageRegistration } from "@shikijs/core";

type CodeLanguageDefinition = {
  aliases: readonly string[];
  label: string;
  load: () => Promise<{ default: LanguageRegistration[] }>;
};

const codeLanguages = {
  bash: {
    aliases: ["bash", "sh", "shell", "zsh"],
    label: "Shell",
    load: () => import("@shikijs/langs/bash"),
  },
  c: { aliases: ["c"], label: "C", load: () => import("@shikijs/langs/c") },
  cpp: {
    aliases: ["cpp"],
    label: "C++",
    load: () => import("@shikijs/langs/cpp"),
  },
  csharp: {
    aliases: ["cs", "csharp"],
    label: "C#",
    load: () => import("@shikijs/langs/csharp"),
  },
  css: {
    aliases: ["css"],
    label: "CSS",
    load: () => import("@shikijs/langs/css"),
  },
  diff: {
    aliases: ["diff"],
    label: "Diff",
    load: () => import("@shikijs/langs/diff"),
  },
  go: { aliases: ["go"], label: "Go", load: () => import("@shikijs/langs/go") },
  html: {
    aliases: ["html"],
    label: "HTML",
    load: () => import("@shikijs/langs/html"),
  },
  java: {
    aliases: ["java"],
    label: "Java",
    load: () => import("@shikijs/langs/java"),
  },
  javascript: {
    aliases: ["javascript", "js"],
    label: "JavaScript",
    load: () => import("@shikijs/langs/javascript"),
  },
  json: {
    aliases: ["json"],
    label: "JSON",
    load: () => import("@shikijs/langs/json"),
  },
  jsx: {
    aliases: ["jsx"],
    label: "JSX",
    load: () => import("@shikijs/langs/jsx"),
  },
  kotlin: {
    aliases: ["kotlin"],
    label: "Kotlin",
    load: () => import("@shikijs/langs/kotlin"),
  },
  markdown: {
    aliases: ["markdown", "md"],
    label: "Markdown",
    load: () => import("@shikijs/langs/markdown"),
  },
  python: {
    aliases: ["python", "py"],
    label: "Python",
    load: () => import("@shikijs/langs/python"),
  },
  ruby: {
    aliases: ["ruby"],
    label: "Ruby",
    load: () => import("@shikijs/langs/ruby"),
  },
  rust: {
    aliases: ["rust", "rs"],
    label: "Rust",
    load: () => import("@shikijs/langs/rust"),
  },
  sql: {
    aliases: ["sql"],
    label: "SQL",
    load: () => import("@shikijs/langs/sql"),
  },
  swift: {
    aliases: ["swift"],
    label: "Swift",
    load: () => import("@shikijs/langs/swift"),
  },
  tsx: {
    aliases: ["tsx"],
    label: "TSX",
    load: () => import("@shikijs/langs/tsx"),
  },
  typescript: {
    aliases: ["typescript", "ts"],
    label: "TypeScript",
    load: () => import("@shikijs/langs/typescript"),
  },
  xml: {
    aliases: ["xml"],
    label: "XML",
    load: () => import("@shikijs/langs/xml"),
  },
  yaml: {
    aliases: ["yaml", "yml"],
    label: "YAML",
    load: () => import("@shikijs/langs/yaml"),
  },
} as const satisfies Record<string, CodeLanguageDefinition>;

export type CodeLanguageId = keyof typeof codeLanguages;
export type CodeLanguage = { id: CodeLanguageId; label: string };

const languagesByAlias = new Map<string, CodeLanguage>();
for (const [id, definition] of Object.entries(codeLanguages)) {
  for (const alias of definition.aliases) {
    languagesByAlias.set(alias, {
      id: id as CodeLanguageId,
      label: definition.label,
    });
  }
}

export function normalizeCodeLanguage(value?: string) {
  const alias = value?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return alias ? languagesByAlias.get(alias) : undefined;
}

export function loadCodeLanguage(language: CodeLanguageId) {
  return codeLanguages[language].load();
}
