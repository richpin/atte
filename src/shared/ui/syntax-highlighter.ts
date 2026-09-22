import { type CodeLanguageId, loadCodeLanguage } from "./code-languages";

export type HighlightToken = {
  content: string;
  color?: string;
  fontStyle?: number;
};

export type HighlightedCode = {
  tokens: HighlightToken[][];
};

type ShikiHighlighter = Awaited<
  ReturnType<typeof import("@shikijs/core")["createHighlighterCore"]>
>;

const maximumCachedHighlights = 100;
const highlightedCode = new Map<string, Promise<HighlightedCode>>();
const languageLoads = new Map<string, Promise<void>>();
let highlighter: Promise<ShikiHighlighter> | undefined;

function getHighlighter() {
  highlighter ??= Promise.all([
    import("@shikijs/core"),
    import("@shikijs/engine-javascript"),
    import("@shikijs/themes/github-light"),
    import("@shikijs/themes/github-dark"),
  ]).then(
    ([
      { createHighlighterCore },
      { createJavaScriptRegexEngine },
      { default: githubLight },
      { default: githubDark },
    ]) =>
      createHighlighterCore({
        themes: [githubLight, githubDark],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      }),
  );
  return highlighter;
}

async function loadLanguage(language: CodeLanguageId) {
  const syntaxHighlighter = await getHighlighter();
  if (syntaxHighlighter.getLoadedLanguages().includes(language)) return;

  let loading = languageLoads.get(language);
  if (!loading) {
    loading = loadCodeLanguage(language).then(({ default: registrations }) =>
      syntaxHighlighter.loadLanguage(...registrations),
    );
    languageLoads.set(language, loading);
  }
  try {
    await loading;
  } catch (error) {
    if (languageLoads.get(language) === loading) languageLoads.delete(language);
    throw error;
  }
}

function trimHighlightCache() {
  while (highlightedCode.size > maximumCachedHighlights) {
    const oldestKey = highlightedCode.keys().next().value;
    if (oldestKey === undefined) return;
    highlightedCode.delete(oldestKey);
  }
}

export function highlightCode(
  source: string,
  language: CodeLanguageId,
  appearance: "light" | "dark",
): Promise<HighlightedCode> {
  const key = `${appearance}\0${language}\0${source}`;
  const cached = highlightedCode.get(key);
  if (cached) return cached;

  const highlighting = (async () => {
    await loadLanguage(language);
    const syntaxHighlighter = await getHighlighter();
    const result = syntaxHighlighter.codeToTokens(source, {
      lang: language,
      theme: appearance === "dark" ? "github-dark" : "github-light",
    });
    return {
      tokens: result.tokens.map((line) =>
        line.map(({ color, content, fontStyle }) => ({
          color,
          content,
          fontStyle,
        })),
      ),
    };
  })();
  highlightedCode.set(key, highlighting);
  trimHighlightCache();
  void highlighting.catch(() => {
    if (highlightedCode.get(key) === highlighting) highlightedCode.delete(key);
  });
  return highlighting;
}
