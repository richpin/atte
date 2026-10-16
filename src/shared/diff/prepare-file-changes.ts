import type { FileChange, PreparedFileChange } from "./types";

/** Load the diff engine only when a completed turn actually has reported changes. */
export async function prepareFileChanges(
  files: FileChange[],
): Promise<PreparedFileChange[]> {
  const { parseDiffFromFile } = await import("@pierre/diffs");
  return files.map((file) => ({
    path: file.path,
    comparisons: file.comparisons.map((comparison) => {
      const diff = parseDiffFromFile(
        comparison.before === null
          ? null
          : { name: file.path, contents: comparison.before },
        comparison.after === null
          ? null
          : { name: file.path, contents: comparison.after },
      );
      // The patch parser infers add/delete from empty content; our version input
      // distinguishes an existing empty file from an absent side explicitly.
      if (comparison.before !== null && comparison.after !== null)
        diff.type = "change";
      return {
        ...comparison,
        diff,
        additions: diff.hunks.reduce(
          (sum, hunk) => sum + hunk.additionLines,
          0,
        ),
        deletions: diff.hunks.reduce(
          (sum, hunk) => sum + hunk.deletionLines,
          0,
        ),
      };
    }),
  }));
}
