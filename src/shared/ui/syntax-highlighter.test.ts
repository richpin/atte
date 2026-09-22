import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const loadedLanguages = new Set<string>();
  const codeToTokens = vi.fn((source: string) => ({
    tokens: [[{ color: "#123456", content: source, fontStyle: 0 }]],
  }));
  const loadLanguage = vi.fn(async (language: string) => {
    loadedLanguages.add(language);
  });
  const highlighter = {
    codeToTokens,
    getLoadedLanguages: () => [...loadedLanguages],
    loadLanguage,
  };
  return {
    codeToTokens,
    createHighlighterCore: vi.fn(async () => highlighter),
    createJavaScriptRegexEngine: vi.fn(() => "javascript-engine"),
    loadLanguage,
    loadedLanguages,
  };
});

vi.mock("@shikijs/core", () => ({
  createHighlighterCore: mocks.createHighlighterCore,
}));
vi.mock("@shikijs/engine-javascript", () => ({
  createJavaScriptRegexEngine: mocks.createJavaScriptRegexEngine,
}));
vi.mock("@shikijs/themes/github-light", () => ({
  default: { name: "github-light" },
}));
vi.mock("@shikijs/themes/github-dark", () => ({
  default: { name: "github-dark" },
}));
vi.mock("@shikijs/langs/typescript", () => ({
  default: [{ name: "typescript" }],
}));
vi.mock("@shikijs/langs/python", () => ({
  default: [{ name: "python" }],
}));

beforeEach(() => {
  vi.resetModules();
  mocks.loadedLanguages.clear();
  mocks.codeToTokens.mockClear();
  mocks.createHighlighterCore.mockClear();
  mocks.createJavaScriptRegexEngine.mockClear();
  mocks.loadLanguage.mockClear();
});

it("initializes once on demand, loads only requested grammars, and reuses exact results", async () => {
  const { highlightCode } = await import("./syntax-highlighter");

  expect(mocks.createHighlighterCore).not.toHaveBeenCalled();

  const first = await highlightCode("const value = 1;", "typescript", "light");
  const cached = await highlightCode("const value = 1;", "typescript", "light");
  await highlightCode("print('ready')", "python", "dark");

  expect(mocks.createHighlighterCore).toHaveBeenCalledTimes(1);
  expect(mocks.createHighlighterCore).toHaveBeenCalledWith({
    engine: "javascript-engine",
    langs: [],
    themes: [{ name: "github-light" }, { name: "github-dark" }],
  });
  expect(mocks.loadLanguage.mock.calls).toEqual([
    [{ name: "typescript" }],
    [{ name: "python" }],
  ]);
  expect(mocks.codeToTokens).toHaveBeenCalledTimes(2);
  expect(cached).toBe(first);
});
