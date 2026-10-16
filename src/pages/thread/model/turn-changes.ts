import type { DiffComparison, FileChange } from "shared/diff";
import type { Turn } from "./types";

export function collectTurnChanges(
  turn: Turn,
  permissionToolIds: readonly string[] = [],
): FileChange[] {
  const files = new Map<string, DiffComparison[]>();
  for (const part of turn.responseParts) {
    if (
      part.kind !== "tool" ||
      part.tool.status !== "completed" ||
      permissionToolIds.includes(part.id)
    )
      continue;
    for (const content of part.tool.content ?? []) {
      // Incomplete historical records cannot be reconstructed from today's files.
      if (content.type !== "diff" || typeof content.newText !== "string")
        continue;
      const comparison: DiffComparison = {
        before: content.oldText ?? null,
        after: part.tool.kind === "delete" ? null : content.newText,
      };
      if (comparison.before === null && comparison.after === null) continue;
      const comparisons = files.get(content.path) ?? [];
      const previous = comparisons.at(-1);
      if (previous && previous.after === comparison.before) {
        previous.after = comparison.after;
      } else {
        comparisons.push(comparison);
      }
      files.set(content.path, comparisons);
    }
  }
  return Array.from(files, ([path, comparisons]) => ({
    path,
    comparisons: comparisons.filter(({ before, after }) => before !== after),
  })).filter((file) => file.comparisons.length > 0);
}
