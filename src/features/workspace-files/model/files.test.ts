import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeSearch,
  type DiskFile,
  listDirectory,
  operateFile,
  readFile,
  saveFile,
  searchPaths,
} from "../api/files";
import { createFilesModel, dirty, treeWidth } from "./files";

vi.mock("../api/files", () => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  searchPaths: vi.fn(),
  closeSearch: vi.fn(),
  saveFile: vi.fn(),
  operateFile: vi.fn(),
}));
const disk = (text = "original", version = "v1"): DiskFile => ({
  text,
  version,
  readOnly: false,
});
const disposers: (() => void)[] = [];
function model() {
  return createRoot((dispose) => {
    disposers.push(dispose);
    return createFilesModel("thread");
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readFile).mockResolvedValue(disk());
  vi.mocked(operateFile).mockResolvedValue();
  vi.mocked(listDirectory).mockResolvedValue({ entries: [], warnings: [] });
  vi.mocked(closeSearch).mockResolvedValue();
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("file drafts", () => {
  it("keeps extensionless files and dotfiles named after image formats as text", async () => {
    const files = model();
    for (const path of ["png", ".png", "folder.png/jpeg"]) {
      await files.open(path);
      expect(readFile).toHaveBeenLastCalledWith("thread", path);
      expect(files.current()?.path).toBe(path);
    }
  });
  it("opens images without drafts and refreshes only for relevant filesystem changes", async () => {
    const files = model();
    await files.open("folder/image.PNG");
    expect(readFile).not.toHaveBeenCalled();
    expect(files.current()).toBeUndefined();
    expect(files.pending()).toHaveLength(0);
    const revision = files.imageRevision();
    await files.update({
      type: "changed",
      paths: ["other.png"],
    });
    expect(files.imageRevision()).toBe(revision);
    await files.update({
      type: "changed",
      paths: ["folder/image.PNG"],
    });
    expect(files.imageRevision()).toBe(revision + 1);
    await files.update({
      type: "changed",
      paths: ["folder"],
    });
    expect(files.imageRevision()).toBe(revision + 2);
    await files.update({ type: "snapshot", entries: [], warnings: [] });
    expect(files.imageRevision()).toBe(revision + 3);
    await files.operation({ type: "move", from: "folder", to: "renamed" });
    expect(files.selected()).toBe("renamed/image.PNG");
    await files.operation({ type: "trash", path: "renamed" });
    expect(files.selected()).toBeUndefined();
  });
  it("preserves text edits across image selections and reads SVG as editable text", async () => {
    const files = model();
    await files.open("file.svg");
    const draft = files.current();
    if (!draft) throw new Error("missing SVG draft");
    files.change(draft.id, "<svg/>");
    await files.open("image.png");
    expect(files.pending()).toHaveLength(1);
    await files.open("file.svg");
    expect(files.current()?.text).toBe("<svg/>");
    expect(files.current()?.id).toBe(draft.id);
  });
  it("keeps edits in multiple files when navigating", async () => {
    const files = model();
    await files.open("first.ts");
    const first = files.current();
    if (!first) throw new Error("missing draft");
    files.change(first.id, "edited first");
    await files.open("second.ts");
    const second = files.current();
    if (!second) throw new Error("missing draft");
    files.change(second.id, "edited second");
    await files.open("first.ts");
    expect(files.current()?.text).toBe("edited first");
    expect(files.pending()).toHaveLength(2);
  });
  it("does not let a late read replace the current selection", async () => {
    let finish!: (value: DiskFile) => void;
    vi.mocked(readFile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const files = model();
    const opening = files.open("slow");
    await files.open("fast");
    finish(disk("slow"));
    await opening;
    expect(files.selected()).toBe("fast");
    expect(files.current()?.text).toBe("original");
  });
  it("keeps characters typed during a save dirty", async () => {
    let finish!: (value: DiskFile) => void;
    vi.mocked(saveFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const files = model();
    await files.open("file");
    const draft = files.current();
    if (!draft) throw new Error("missing draft");
    files.change(draft.id, "submitted");
    const saving = files.save(draft.id);
    files.change(draft.id, "submitted plus more");
    finish(disk("submitted", "v2"));
    await saving;
    expect(draft.text).toBe("submitted plus more");
    expect(draft.disk.version).toBe("v2");
    expect(dirty(draft)).toBe(true);
  });
  it("retains a dirty buffer and exposes the external version on change", async () => {
    const files = model();
    await files.open("file");
    const draft = files.current();
    if (!draft) throw new Error("missing draft");
    files.change(draft.id, "mine");
    vi.mocked(readFile).mockResolvedValue(disk("theirs", "v2"));
    await files.update({
      type: "changed",
      paths: ["file"],
    });
    expect(draft.text).toBe("mine");
    expect(draft.external?.text).toBe("theirs");
    expect(draft.problem).toBe("conflict");
    expect(await files.save(draft.id)).toBe(false);
    expect(saveFile).not.toHaveBeenCalled();
  });
  it("refreshes a clean file without losing the selected file", async () => {
    const files = model();
    await files.open("file");
    vi.mocked(readFile).mockResolvedValue(disk("new", "v2"));
    await files.update({ type: "snapshot", entries: [], warnings: [] });
    expect(files.current()?.text).toBe("new");
    expect(files.current()?.revision).toBe(1);
  });
  it("retains unsaved edits when the file disappears", async () => {
    const files = model();
    await files.open("file");
    const draft = files.current();
    if (!draft) throw new Error("missing draft");
    files.change(draft.id, "mine");
    vi.mocked(readFile).mockRejectedValue("missing");
    await files.update({
      type: "changed",
      paths: ["file"],
    });
    expect(draft.text).toBe("mine");
    expect(draft.problem).toBe("missing");
    expect(await files.saveAll()).toBe(false);
  });
  it("keeps the draft identity and contents when its folder moves", async () => {
    const files = model();
    await files.open("folder/file");
    const draft = files.current();
    if (!draft) throw new Error("missing draft");
    files.change(draft.id, "mine");
    await files.operation({ type: "move", from: "folder", to: "renamed" });
    expect(files.current()?.id).toBe(draft.id);
    expect(draft.path).toBe("renamed/file");
    expect(draft.text).toBe("mine");
  });
  it("retains files and drafts when a filesystem operation fails", async () => {
    const files = model();
    await files.open("file");
    vi.mocked(operateFile).mockRejectedValue("exists");
    expect(
      await files.operation({ type: "move", from: "file", to: "other" }),
    ).toBe(false);
    expect(files.current()?.path).toBe("file");
    expect(files.error()).toBe("exists");
  });
  it("does not mark failed saves as clean", async () => {
    const files = model();
    await files.open("file");
    const draft = files.current();
    if (!draft) throw new Error("missing draft");
    files.change(draft.id, "mine");
    vi.mocked(saveFile).mockRejectedValue({ io: "permission denied" });
    expect(await files.saveAll()).toBe(false);
    expect(draft.text).toBe("mine");
    expect(dirty(draft)).toBe(true);
  });
});
describe("incremental directory tree", () => {
  it("prefetches only the root and loads each expanded directory once", async () => {
    vi.mocked(listDirectory).mockImplementation(async (_thread, path) => ({
      entries:
        path === ""
          ? [{ path: ".git", directory: true, symlink: false }]
          : [{ path: ".git/config", directory: false, symlink: false }],
      warnings: [],
    }));
    const files = model();
    await files.prefetch();
    await files.prefetch();
    expect(listDirectory).toHaveBeenCalledTimes(1);
    expect(files.entries().map((entry) => entry.path)).toEqual([".git"]);
    await files.loadDirectory(".git");
    await files.loadDirectory(".git");
    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(files.entries().map((entry) => entry.path)).toEqual([
      ".git",
      ".git/config",
    ]);
    expect(readFile).not.toHaveBeenCalled();
  });
  it("refreshes loaded parents only and removes deleted descendants", async () => {
    let rootHasFolder = true;
    vi.mocked(listDirectory).mockImplementation(async (_thread, path) => ({
      entries:
        path === ""
          ? rootHasFolder
            ? [{ path: "folder", directory: true, symlink: false }]
            : []
          : [{ path: "folder/file", directory: false, symlink: false }],
      warnings: [],
    }));
    const files = model();
    await files.prefetch();
    await files.loadDirectory("folder");
    await files.update({ type: "changed", paths: ["unloaded/deep/file"] });
    expect(listDirectory).toHaveBeenCalledTimes(2);
    rootHasFolder = false;
    await files.update({ type: "changed", paths: ["folder"] });
    expect(files.entries()).toEqual([]);
    expect(files.loaded("folder")).toBe(false);
  });
  it("does not let a late prefetch replace the watcher snapshot", async () => {
    let finish!: (listing: {
      entries: { path: string; directory: boolean; symlink: boolean }[];
      warnings: string[];
    }) => void;
    vi.mocked(listDirectory).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const files = model();
    const prefetch = files.prefetch();
    await files.update({
      type: "snapshot",
      entries: [{ path: "new", directory: false, symlink: false }],
      warnings: [],
    });
    finish({
      entries: [{ path: "old", directory: false, symlink: false }],
      warnings: [],
    });
    await prefetch;
    expect(files.entries().map((entry) => entry.path)).toEqual(["new"]);
  });
  it("retries a failed folder and keeps search results separate from loaded paths", async () => {
    vi.mocked(listDirectory)
      .mockResolvedValueOnce({
        entries: [{ path: "folder", directory: true, symlink: false }],
        warnings: [],
      })
      .mockRejectedValueOnce("denied")
      .mockResolvedValue({ entries: [], warnings: [] });
    vi.mocked(searchPaths).mockResolvedValue([
      { path: "folder/deep/match.ts", directory: false, symlink: false },
    ]);
    const files = model();
    await files.prefetch();
    await files.loadDirectory("folder");
    expect(files.directoryErrors().folder).toBe("denied");
    await files.loadDirectory("folder");
    expect(files.directoryErrors().folder).toBeUndefined();
    await files.search("match");
    await vi.waitFor(() => expect(files.searchResults()).toHaveLength(1));
    expect(files.entries().map((entry) => entry.path)).toEqual(["folder"]);
    await files.search("");
    expect(files.searchResults()).toEqual([]);
    expect(closeSearch).toHaveBeenCalledOnce();
  });
});
it("allocates eighty percent of panel resizing to the file and clamps minima", () => {
  expect(treeWidth(360, 360, 140)).toBe(140);
  expect(treeWidth(460, 360, 140)).toBe(160);
  expect(treeWidth(320, 360, 140)).toBe(132);
  expect(treeWidth(320, 360, 300)).toBe(160);
  expect(treeWidth(320, 360, 100)).toBe(100);
});
