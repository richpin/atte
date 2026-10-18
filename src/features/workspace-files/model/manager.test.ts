import { createRoot } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { readFile, saveFile } from "../api/files";
import { createFilesManager } from "./manager";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));
vi.mock("../api/files", () => ({
  readFile: vi.fn(),
  saveFile: vi.fn(),
  operateFile: vi.fn(),
}));
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.resetAllMocks();
});
async function setup() {
  const manager = createRoot((dispose) => {
    disposers.push(dispose);
    return createFilesManager((key) => key);
  });
  const model = manager.get("thread");
  vi.mocked(readFile).mockResolvedValue({
    text: "original",
    version: "v1",
    readOnly: false,
  });
  await model.open("file");
  const draft = model.current();
  if (!draft) throw new Error("missing draft");
  model.change(draft.id, "edited");
  return { manager, model, draft };
}
it("cancels tab close or thread deletion without losing edits", async () => {
  const { manager, draft } = await setup();
  const closing = manager.guard("thread");
  manager.answer("cancel");
  expect(await closing).toBe(false);
  expect(draft.text).toBe("edited");
});
it("discards edits only after an explicit discard decision", async () => {
  const { manager, model } = await setup();
  const closing = manager.guard("thread");
  manager.answer("discard");
  expect(await closing).toBe(true);
  expect(model.pending()).toHaveLength(0);
});
it("saves all edited files before allowing close or quit", async () => {
  const { manager, model } = await setup();
  await model.open("second");
  const second = model.current();
  if (!second) throw new Error("missing draft");
  model.change(second.id, "second edit");
  vi.mocked(saveFile).mockImplementation(
    async (_thread, _path, _version, text) => ({
      text,
      version: "v2",
      readOnly: false,
    }),
  );
  const quitting = manager.guard();
  manager.answer("save");
  expect(await quitting).toBe(true);
  expect(saveFile).toHaveBeenCalledTimes(2);
  expect(model.pending()).toHaveLength(0);
});
it("blocks closing on a failed save and preserves the draft", async () => {
  const { manager, model, draft } = await setup();
  vi.mocked(saveFile).mockRejectedValue("conflict");
  const closing = manager.guard();
  manager.answer("save");
  await vi.waitFor(() =>
    expect(manager.dialog()?.title).toBe("files.saveFailed"),
  );
  manager.answer("cancel");
  expect(await closing).toBe(false);
  expect(draft.text).toBe("edited");
  expect(model.pending()).toHaveLength(1);
});
