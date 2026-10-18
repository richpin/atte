import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "shared/i18n";
import { For } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { operateFile, readFile, subscribeFiles } from "../api/files";
import type { FilesModel } from "../model/files";
import { createFilesManager } from "../model/manager";
import { FilesDialogs } from "./FilesDialogs";
import { WorkspaceFiles } from "./WorkspaceFiles";

vi.mock("../api/files", () => ({
  readFile: vi.fn(),
  saveFile: vi.fn(),
  operateFile: vi.fn(),
  subscribeFiles: vi.fn(),
}));
vi.mock("shared/ui", async (original) => {
  const actual = await original<typeof import("shared/ui")>();
  return {
    ...actual,
    EditableFile: () => null,
    FileTree: (props: Parameters<typeof actual.FileTree>[0]) => (
      <>
        <For each={props.entries}>
          {(entry) => (
            <>
              <button
                type="button"
                onClick={() => props.onSelect(entry.path, entry.directory)}
              >
                {entry.path}
              </button>
              <button
                type="button"
                onClick={() =>
                  props.onAction("trash", entry.path, entry.directory)
                }
              >
                Trash {entry.path}
              </button>
            </>
          )}
        </For>
        <button
          type="button"
          onClick={() => void props.onMove("folder", "renamed")}
        >
          Move fixture folder
        </button>
      </>
    ),
  };
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.mocked(operateFile).mockResolvedValue();
  vi.mocked(subscribeFiles).mockImplementation(async (_thread, receive) => {
    await Promise.resolve();
    receive({
      type: "snapshot",
      entries: [{ path: "folder", directory: true, symlink: false }],
      warnings: [],
    });
    return async () => undefined;
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it("creates inside the moved selection and returns to the root after that folder is trashed", async () => {
  render(() => (
    <I18nProvider>
      <Fixture />
    </I18nProvider>
  ));
  await userEvent.click(await screen.findByRole("button", { name: "folder" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Move fixture folder" }),
  );
  await screen.findByRole("button", { name: "renamed" });
  await userEvent.click(await screen.findByRole("button", { name: "새 폴더" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "새 폴더" }),
    "child",
  );
  await userEvent.click(screen.getByRole("button", { name: "생성" }));
  await waitFor(() =>
    expect(operateFile).toHaveBeenCalledWith("thread", {
      type: "create",
      path: "renamed/child",
      directory: true,
    }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "renamed" }));
  await userEvent.click(screen.getByRole("button", { name: "Trash renamed" }));
  await userEvent.click(
    screen.getByRole("button", { name: "휴지통으로 이동" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "renamed" })).toBeNull(),
  );
  await userEvent.click(await screen.findByRole("button", { name: "새 폴더" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "새 폴더" }),
    "root-child",
  );
  await userEvent.click(screen.getByRole("button", { name: "생성" }));
  await waitFor(() =>
    expect(operateFile).toHaveBeenCalledWith("thread", {
      type: "create",
      path: "root-child",
      directory: true,
    }),
  );
});
it("warns about unsaved descendants before trashing a selected folder", async () => {
  vi.mocked(readFile).mockResolvedValue({
    text: "original",
    version: "v1",
    readOnly: false,
  });
  let model!: FilesModel;
  render(() => (
    <I18nProvider>
      <Fixture
        onModel={(value) => {
          model = value;
        }}
      />
    </I18nProvider>
  ));
  await screen.findByRole("button", { name: "folder" });
  await model.open("folder/app.ts");
  const draft = model.current();
  if (!draft) throw new Error("Expected an open draft");
  model.change(draft.id, "unsaved edits");
  await userEvent.click(screen.getByRole("button", { name: "folder" }));
  await userEvent.click(screen.getByRole("button", { name: "Trash folder" }));
  expect(screen.getByRole("dialog").textContent).toContain("folder/app.ts");
  expect(operateFile).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "휴지통으로 이동" }),
  );
  await waitFor(() =>
    expect(operateFile).toHaveBeenCalledWith("thread", {
      type: "trash",
      path: "folder",
    }),
  );
  await waitFor(() => expect(model.pending()).toHaveLength(0));
  expect(Object.values(model.drafts)).toHaveLength(0);
});
function Fixture(props: { onModel?: (model: FilesModel) => void }) {
  const manager = createFilesManager((key) => key);
  const model = manager.get("thread");
  props.onModel?.(model);
  return (
    <>
      <WorkspaceFiles model={model} manager={manager} visible />
      <FilesDialogs manager={manager} />
    </>
  );
}
