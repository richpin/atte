import { expect, it } from "vitest";
import { groupResponseParts } from "./response-groups";
import type { ResponsePart } from "./types";

it("groups mixed work items and preserves every other response type as a boundary", () => {
  const parts: ResponsePart[] = [
    { kind: "thought", id: "thinking", text: "Inspect" },
    { kind: "tool", id: "read", tool: { kind: "read" } },
    { kind: "text", id: "text", text: "Answer" },
    { kind: "tool", id: "search", tool: {} },
    { kind: "content", id: "image", content: { type: "image" } },
    { kind: "thought", id: "review", text: "Review" },
    { kind: "plan", id: "plan", plan: { entries: [] } },
    { kind: "tool", id: "edit", tool: {} },
    { kind: "planContent", id: "doc", planId: "p", content: null },
    { kind: "thought", id: "finish", text: "Finish" },
  ];
  const groups = groupResponseParts(parts);
  expect(
    groups.map((group) => [
      group.id,
      group.startIndex,
      group.workLog,
      group.parts.length,
    ]),
  ).toEqual([
    ["thinking", 0, true, 2],
    ["text", 2, false, 1],
    ["search", 3, true, 1],
    ["image", 4, false, 1],
    ["review", 5, true, 1],
    ["plan", 6, false, 1],
    ["edit", 7, true, 1],
    ["doc", 8, false, 1],
    ["finish", 9, true, 1],
  ]);
  expect(groups.flatMap((group) => group.parts)).toEqual(parts);
  expect(groupResponseParts([])).toEqual([]);
});
