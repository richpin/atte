import { expect, it } from "vitest";
import { highlightCode } from "./syntax-highlighter";

it("loads a real grammar lazily and preserves the exact source in tokens", async () => {
  const source = "const value: number = 1;";
  const result = await highlightCode(source, "typescript", "light");

  expect(
    result.tokens
      .flatMap((line, index) => [
        ...line.map((token) => token.content),
        ...(index < result.tokens.length - 1 ? ["\n"] : []),
      ])
      .join(""),
  ).toBe(source);
  expect(result.tokens.flat().some((token) => token.color)).toBe(true);
});
