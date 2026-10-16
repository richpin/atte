import type { FileDiffMetadata } from "@pierre/diffs";

/** Null denotes an absent file; an empty string denotes an existing empty file. */
export type DiffComparison = { before: string | null; after: string | null };

export type FileChange = { path: string; comparisons: DiffComparison[] };

export type PreparedComparison = DiffComparison & {
  diff: FileDiffMetadata;
  additions: number;
  deletions: number;
};

export type PreparedFileChange = {
  path: string;
  comparisons: PreparedComparison[];
};
