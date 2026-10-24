import type { FileDiffMetadata } from "@pierre/diffs";

export async function prepareCommitPatch(
  patch: string,
  file: { path: string; oldPath: string | null },
  key: string,
): Promise<FileDiffMetadata | undefined> {
  const { parsePatchFiles } = await import("@pierre/diffs");
  const diff = parsePatchFiles(patch, key, true).flatMap(
    (patch) => patch.files,
  )[0];
  if (!diff) return undefined;
  // Raw -z records are authoritative; quoted patch headers are display syntax.
  return { ...diff, name: file.path, prevName: file.oldPath ?? undefined };
}
