import { expect, it } from "vitest";
import { collectTurnChanges } from "./turn-changes";
import type { ResponsePart, ToolCall, Turn } from "./types";

function edit(
  id: string,
  before: string | null,
  after: string,
  options: Partial<ToolCall> = {},
): ResponsePart {
  return {
    kind: "tool",
    id,
    tool: {
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/project/a.ts",
          oldText: before,
          newText: after,
        },
      ],
      ...options,
    },
  };
}
function turn(...responseParts: ResponsePart[]): Turn {
  return { id: "turn", message: "", stopReason: null, responseParts };
}

it("merges consecutive versions while counting a file once", () => {
  expect(
    collectTurnChanges(
      turn(edit("a", "one", "two"), edit("b", "two", "three")),
    ),
  ).toEqual([
    { path: "/project/a.ts", comparisons: [{ before: "one", after: "three" }] },
  ]);
});

it("removes a reverted file, but keeps a new empty file and an empty existing file", () => {
  expect(
    collectTurnChanges(turn(edit("a", "one", "two"), edit("b", "two", "one"))),
  ).toEqual([]);
  expect(collectTurnChanges(turn(edit("a", null, "")))[0].comparisons).toEqual([
    { before: null, after: "" },
  ]);
  expect(
    collectTurnChanges(turn(edit("a", "", "value")))[0].comparisons,
  ).toEqual([{ before: "", after: "value" }]);
});

it("keeps discontinuous modifications as ordered comparisons", () => {
  expect(
    collectTurnChanges(
      turn(edit("a", "one", "two"), edit("b", "external edit", "three")),
    )[0].comparisons,
  ).toEqual([
    { before: "one", after: "two" },
    { before: "external edit", after: "three" },
  ]);
});

it("only includes confirmed completed calls, including on a cancelled turn", () => {
  const cancelled = {
    ...turn(
      edit("a", "one", "two"),
      edit("b", "two", "three", { status: "failed" }),
      edit("c", "two", "four", { status: "in_progress" }),
      edit("d", "two", "five", { status: "pending" }),
      edit("permission", "two", "six"),
    ),
    stopReason: "cancelled",
  };
  expect(collectTurnChanges(cancelled, ["permission"])[0].comparisons).toEqual([
    { before: "one", after: "two" },
  ]);
});

it("recognizes reported deletion without confusing an emptied file with deletion", () => {
  expect(
    collectTurnChanges(turn(edit("a", "value", "", { kind: "delete" })))[0]
      .comparisons,
  ).toEqual([{ before: "value", after: null }]);
  expect(
    collectTurnChanges(turn(edit("a", "value", "", { kind: "edit" })))[0]
      .comparisons,
  ).toEqual([{ before: "value", after: "" }]);
});

it("does not mutate ACP snapshots while merging repeated edits", () => {
  const initial = turn(edit("a", "one", "two"), edit("b", "two", "three"));
  const snapshot = structuredClone(initial);
  collectTurnChanges(initial);
  expect(initial).toEqual(snapshot);
});
