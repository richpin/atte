import { expect, it } from "vitest";
import { prepareCommitPatch } from "./git-patch";

it("parses a Git patch with partial context and preserves authoritative names", async () => {
  const diff = await prepareCommitPatch(
    "1\t1\ta.ts\n\ndiff --git a/a.ts b/a.ts\nindex 1234567..abcdef0 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    {
      path: "한글\tfile.ts",
      oldPath: null,
    },
    "commit:file",
  );
  expect(diff?.name).toBe("한글\tfile.ts");
  expect(diff?.isPartial).toBe(true);
  expect(diff?.hunks).toHaveLength(1);
});
it("handles pure rename and mode-only patches without inventing text changes", async () => {
  for (const patch of [
    "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n",
    "diff --git a/script b/script\nold mode 100644\nnew mode 100755\n",
  ]) {
    const diff = await prepareCommitPatch(
      patch,
      {
        path: "new",
        oldPath: "old",
      },
      "metadata",
    );
    expect(diff?.hunks.length ?? 0).toBe(0);
  }
});
