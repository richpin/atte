import { expect, it } from "vitest";
import {
  commandQuery,
  completeCommand,
  matchingCommands,
} from "./slash-commands";

it("only queries the first command token and permits selecting its name", () => {
  expect(commandQuery("/", 1, 1)).toBe("");
  expect(commandQuery("/review arg", 3, 7)).toBe("review");
  expect(commandQuery("/review arg", 8, 8)).toBeUndefined();
  expect(commandQuery("/review", 0, 7)).toBeUndefined();
  for (const value of [
    " /review",
    "text /review",
    "text\n/review",
    "https://site",
  ]) {
    expect(commandQuery(value, value.length, value.length)).toBeUndefined();
  }
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
  expect(completeCommand("/rev", "review")).toEqual({
    value: "/review ",
    cursor: 8,
  });
  expect(completeCommand("/rev  first\nsecond", "review")).toEqual({
    value: "/review  first\nsecond",
    cursor: 8,
  });
});
