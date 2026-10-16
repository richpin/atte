import { expect, it } from "vitest";
import { prepareFileChanges } from "./prepare-file-changes";

it("counts changed lines rather than context lines using the renderer's metadata", async () => {
  const [file] = await prepareFileChanges([
    {
      path: "a.ts",
      comparisons: [
        {
          before: "context\nold\nlast\n",
          after: "context\nnew\nextra\nlast\n",
        },
      ],
    },
  ]);
  expect(file.comparisons[0]).toMatchObject({ additions: 2, deletions: 1 });
  expect(file.comparisons[0].diff.hunks).toHaveLength(1);
});

it("preserves added/deleted and existing empty files", async () => {
  const files = await prepareFileChanges([
    { path: "new.ts", comparisons: [{ before: null, after: "" }] },
    { path: "old.ts", comparisons: [{ before: "removed\n", after: null }] },
    { path: "empty.ts", comparisons: [{ before: "old\n", after: "" }] },
  ]);
  expect(files.map((file) => file.comparisons[0].diff.type)).toEqual([
    "new",
    "deleted",
    "change",
  ]);
  expect(files[1].comparisons[0]).toMatchObject({ additions: 0, deletions: 1 });
});

it("retains the reported source outside hunks for expanding context without reading live files", async () => {
  const lines = Array.from(
    { length: 120 },
    (_, index) => `line ${index + 1}\n`,
  );
  const before = lines.join("");
  lines[59] = "changed line 60\n";
  const after = lines.join("");
  const [file] = await prepareFileChanges([
    { path: "context.txt", comparisons: [{ before, after }] },
  ]);
  const { diff, additions, deletions } = file.comparisons[0];
  expect(diff.isPartial).toBe(false);
  expect(diff.deletionLines.join("")).toBe(before);
  expect(diff.additionLines.join("")).toBe(after);
  expect(diff.hunks[0].collapsedBefore).toBeGreaterThan(20);
  expect({ additions, deletions }).toEqual({ additions: 1, deletions: 1 });
});
