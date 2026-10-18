import { FileTree, prepareFileTreeInput } from "@pierre/trees";
import { afterEach, expect, it, vi } from "vitest";
import { createTreePathSync } from "./file-tree-paths";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
function fixture(paths: string[]) {
  const tree = new FileTree({
    paths: [],
    initialExpansion: "closed",
    search: true,
  });
  const sync = createTreePathSync(tree);
  sync.initialize(prepareFileTreeInput(paths));
  cleanup.push(() => {
    sync.dispose();
    tree.cleanUp();
  });
  return { tree, sync };
}
it("batches only changed paths and preserves expansion, selection, focus and search", () => {
  const { tree, sync } = fixture(["src/", "src/app.ts", "old.ts"]);
  const directory = tree.getItem("src");
  if (!directory || !("expand" in directory))
    throw new Error("Expected directory");
  directory.expand();
  tree.getItem("src/app.ts")?.select();
  tree.focusPath("src/app.ts");
  tree.setSearch("App");
  const reset = vi.spyOn(tree, "resetPaths");
  const batch = vi.spyOn(tree, "batch");
  const next = ["src/", "src/app.ts", "src/new.ts"];
  expect(sync.update(next)).toBe(true);
  expect(batch).toHaveBeenCalledExactlyOnceWith([
    { type: "remove", path: "old.ts", recursive: false },
    { type: "add", path: "src/new.ts" },
  ]);
  expect(sync.update([...next])).toBe(false);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(reset).not.toHaveBeenCalled();
  expect(directory.isExpanded()).toBe(true);
  expect(tree.getSelectedPaths()).toEqual(["src/app.ts"]);
  expect(tree.getFocusedPath()).toBe("src/app.ts");
  expect(tree.getSearchValue()).toBe("App");
});
it("does not repeat optimistic directory moves when disk confirmation arrives", () => {
  const { tree, sync } = fixture(["src/", "src/app.ts", "dest/"]);
  const directory = tree.getItem("src");
  if (!directory || !("expand" in directory))
    throw new Error("Expected directory");
  directory.expand();
  tree.getItem("src/app.ts")?.select();
  tree.move("src/", "dest/");
  const reset = vi.spyOn(tree, "resetPaths");
  const batch = vi.spyOn(tree, "batch");
  expect(sync.update(["dest/", "dest/src/", "dest/src/app.ts"])).toBe(false);
  expect(batch).not.toHaveBeenCalled();
  expect(reset).not.toHaveBeenCalled();
  expect(tree.getSelectedPaths()).toEqual(["dest/src/app.ts"]);
  const moved = tree.getItem("dest/src");
  expect(moved && "isExpanded" in moved && moved.isExpanded()).toBe(true);
});
it("removes a deleted subtree once, retains empty directories, and handles file/directory type changes", () => {
  const { tree, sync } = fixture([
    "folder/",
    "folder/nested/",
    "folder/nested/a",
    "keep/",
    "keep/a",
    "item",
  ]);
  const batch = vi.spyOn(tree, "batch");
  sync.update(["keep/", "item/", "item/child"]);
  expect(batch).toHaveBeenCalledExactlyOnceWith([
    { type: "remove", path: "folder/", recursive: true },
    { type: "remove", path: "keep/a", recursive: false },
    { type: "remove", path: "item", recursive: false },
    { type: "add", path: "item/" },
    { type: "add", path: "item/child" },
  ]);
  expect(tree.getItem("folder")).toBeNull();
  expect(tree.getItem("keep")?.isDirectory()).toBe(true);
  expect(tree.getItem("keep/a")).toBeNull();
  expect(tree.getItem("item")?.isDirectory()).toBe(true);
  sync.update(["keep/", "item"]);
  expect(tree.getItem("item")?.isDirectory()).toBe(false);
  expect(sync.has("item/child")).toBe(false);
});
