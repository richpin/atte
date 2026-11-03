import { expect, it } from "vitest";
import {
  commandQuery,
  completeCommand,
  matchingCommands,
} from "./slash-commands";

it("queries the command at the selection on any line or inside any text", () => {
  expect(commandQuery("/", 1, 1)).toEqual({ query: "", start: 0, end: 1 });
  expect(commandQuery("/review arg", 3, 7)).toEqual({
    query: "review",
    start: 0,
    end: 7,
  });
  expect(commandQuery("/review arg", 8, 8)).toBeUndefined();
  expect(commandQuery("/review", 0, 7)).toBeUndefined();
  for (const value of [
    " ",
    "text ",
    "text\n",
    "https://site",
    "word",
    "src/",
  ]) {
    const text = `${value}/review`;
    expect(commandQuery(text, text.length, text.length)).toEqual({
      query: "review",
      start: value.length,
      end: text.length,
    });
  }
});

it("bounds queries by whitespace and slashes and requires selection inside the name", () => {
  expect(commandQuery("/rev/path", 3, 4)).toEqual({
    query: "rev",
    start: 0,
    end: 4,
  });
  expect(commandQuery("/rev/path", 5, 9)).toEqual({
    query: "path",
    start: 4,
    end: 9,
  });
  expect(commandQuery("/rev/path", 3, 6)).toBeUndefined();
  expect(commandQuery("/rev\ntext", 6, 6)).toBeUndefined();
  expect(commandQuery("plain", 5, 5)).toBeUndefined();
  expect(commandQuery("//", 2, 2)).toEqual({ query: "", start: 1, end: 2 });
});

it("matches names case insensitively and puts prefixes before other substrings", () => {
  const commands = ["pre-review", "review-z", "Review-a", "other"].map(
    (name) => ({
      name,
      description: "review description",
      inputHint: null,
    }),
  );
  expect(
    matchingCommands(commands, "REVIEW").map((command) => command.name),
  ).toEqual(["Review-a", "review-z", "pre-review"]);
  expect(matchingCommands(commands, "absent")).toEqual([]);
  expect(commands[0].name).toBe("pre-review");
});

it("replaces only the command name, preserving whitespace and multiline arguments", () => {
  const range = { query: "rev", start: 0, end: 4 };
  expect(completeCommand("/rev", "review", range)).toEqual({
    value: "/review ",
    cursor: 8,
  });
  expect(completeCommand("/rev  first\nsecond", "review", range)).toEqual({
    value: "/review  first\nsecond",
    cursor: 7,
  });
  expect(
    completeCommand("text\n/rev/path", "review", {
      query: "rev",
      start: 5,
      end: 9,
    }),
  ).toEqual({
    value: "text\n/review/path",
    cursor: 12,
  });
});
