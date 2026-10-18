import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DiskFile, operateFile, readFile, saveFile } from "../api/files";
import { createFilesModel, dirty, treeWidth } from "./files";

vi.mock("../api/files", () => ({
  readFile: vi.fn(),
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
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("file drafts", () => {
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
      changed: ["file"],
      entries: [],
      removed: [],
      warnings: [],
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
      changed: [],
      entries: [],
      removed: ["file"],
      warnings: [],
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
it("allocates eighty percent of panel resizing to the file and clamps minima", () => {
  expect(treeWidth(360, 360, 140)).toBe(140);
  expect(treeWidth(460, 360, 140)).toBe(160);
  expect(treeWidth(320, 360, 140)).toBe(132);
  expect(treeWidth(320, 360, 300)).toBe(160);
  expect(treeWidth(320, 360, 100)).toBe(100);
});
