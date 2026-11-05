import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFilesManager } from "./manager";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, () => Promise<void>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke,
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, receive: () => Promise<void>) => {
    listeners.set(name, receive);
    return () => listeners.delete(name);
  },
}));

beforeEach(() => {
  invoke.mockReset();
  listeners.clear();
  invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "read_workspace_file"
        ? { text: "original", version: "v1", readOnly: false }
        : undefined,
    ),
  );
});
afterEach(cleanup);

async function mount() {
  let manager!: ReturnType<typeof createFilesManager>;
  render(() => {
    manager = createFilesManager((key) => key);
    return null;
  });
  const model = manager.get("thread");
  await model.open("file.txt");
  const draft = model.current();
  if (!draft) throw new Error("Missing opened file");
  model.change(draft.id, "edited");
  const requestQuit = listeners.get("files-quit-requested");
  if (!requestQuit) throw new Error("Missing quit listener");
  return { manager, model, draft, requestQuit };
}

it("cancels a quit request without losing edits and allows a later explicit discard", async () => {
  const { manager, model, draft, requestQuit } = await mount();
  const firstRequest = requestQuit();
  expect(
    invoke.mock.calls.filter(([command]) => command === "resolve_quit"),
  ).toEqual([]);
  manager.answer("cancel");
  await firstRequest;
  expect(invoke).toHaveBeenLastCalledWith("resolve_quit", { proceed: false });
  expect(draft.text).toBe("edited");
  expect(model.pending()).toHaveLength(1);

  const nextRequest = requestQuit();
  manager.answer("discard");
  await nextRequest;
  expect(invoke).toHaveBeenLastCalledWith("resolve_quit", { proceed: true });
  expect(model.pending()).toHaveLength(0);
});

it("waits for saving to finish before allowing the requested quit", async () => {
  const { manager, model, requestQuit } = await mount();
  let finishSave!: (file: {
    text: string;
    version: string;
    readOnly: boolean;
  }) => void;
  const saved = new Promise((resolve) => {
    finishSave = resolve;
  });
  invoke.mockImplementation((command) =>
    command === "save_workspace_file" ? saved : Promise.resolve(),
  );
  const request = requestQuit();
  manager.answer("save");
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("save_workspace_file", {
      threadId: "thread",
      path: "file.txt",
      version: "v1",
      text: "edited",
    }),
  );
  expect(
    invoke.mock.calls.filter(([command]) => command === "resolve_quit"),
  ).toEqual([]);
  finishSave({ text: "edited", version: "v2", readOnly: false });
  await request;
  expect(invoke).toHaveBeenLastCalledWith("resolve_quit", { proceed: true });
  expect(model.pending()).toHaveLength(0);
});
