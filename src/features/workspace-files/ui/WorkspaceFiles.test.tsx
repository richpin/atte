import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "shared/i18n";
import { createSignal, For } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  operateFile,
  readFile,
  readImage,
  saveFile,
  subscribeFiles,
} from "../api/files";
import type { FilesModel } from "../model/files";
import { createFilesManager } from "../model/manager";
import { FilesDialogs } from "./FilesDialogs";
import { WorkspaceFiles } from "./WorkspaceFiles";

vi.mock("../api/files", () => ({
  readFile: vi.fn(),
  readImage: vi.fn(),
  saveFile: vi.fn(),
  operateFile: vi.fn(),
  subscribeFiles: vi.fn(),
}));
vi.mock("shared/ui", async (original) => {
  const actual = await original<typeof import("shared/ui")>();
  return {
    ...actual,
    EditableFile: (props: Parameters<typeof actual.EditableFile>[0]) => (
      <textarea
        aria-label={props.path}
        value={props.text}
        hidden={!props.visible}
        onInput={(event) => props.onChange(event.currentTarget.value)}
      />
    ),
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
  let nextUrl = 0;
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => `blob:preview-${++nextUrl}`),
    revokeObjectURL: vi.fn(),
  });
  vi.mocked(readImage).mockResolvedValue(new ArrayBuffer(4));
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

it("shows an unreadable file warning in that file's content area", async () => {
  const warning = "Only UTF-8 text files up to 2 MiB can be opened";
  vi.mocked(readFile)
    .mockRejectedValueOnce(warning)
    .mockResolvedValue({ text: "readable", version: "v1", readOnly: false });
  vi.mocked(subscribeFiles).mockImplementation(async (_thread, receive) => {
    receive({
      type: "snapshot",
      entries: [
        { path: "binary.dat", directory: false, symlink: false },
        { path: "notes.txt", directory: false, symlink: false },
      ],
      warnings: [],
    });
    return async () => undefined;
  });
  const view = render(() => (
    <I18nProvider>
      <Fixture />
    </I18nProvider>
  ));
  await userEvent.click(
    await screen.findByRole("button", { name: "binary.dat" }),
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(warning);
  const panels = view.container.querySelectorAll(
    "[data-corvu-resizable-panel]",
  );
  expect(panels[1]?.contains(alert)).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "notes.txt" }));
  await screen.findByRole("textbox", { name: "notes.txt" });
  expect(screen.queryByRole("alert")).toBeNull();
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
it("previews SVG edits, keeps them across image navigation, and preserves save and conflict handling", async () => {
  const original = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const edited =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>window.executed = true</script></svg>';
  vi.mocked(readFile).mockResolvedValue({
    text: original,
    version: "v1",
    readOnly: false,
  });
  let model!: FilesModel;
  const view = render(() => (
    <I18nProvider>
      <Fixture
        onModel={(value) => {
          model = value;
        }}
      />
    </I18nProvider>
  ));
  await model.open("image.svg");
  await screen.findByAltText("image.svg");
  expect(screen.queryByRole("textbox", { name: "image.svg" })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "소스", pressed: false }),
  );
  expect(URL.revokeObjectURL).toHaveBeenCalled();
  fireEvent.input(screen.getByRole("textbox", { name: "image.svg" }), {
    target: { value: edited },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "미리보기", pressed: false }),
  );
  await screen.findByAltText("image.svg");
  expect(model.current()?.text).toBe(edited);
  expect(view.container.querySelector("script")).toBeNull();
  vi.mocked(saveFile).mockResolvedValue({
    text: edited,
    version: "v2",
    readOnly: false,
  });
  await userEvent.click(screen.getByRole("button", { name: "저장" }));
  expect(saveFile).toHaveBeenCalledWith("thread", "image.svg", "v1", edited);
  expect(model.pending()).toHaveLength(0);
  model.change(model.current()?.id as string, `${edited}\n`);
  await model.open("image.PNG");
  await screen.findByAltText("image.PNG");
  expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
  expect(screen.queryByAltText("image.svg")).toBeNull();
  vi.mocked(readFile).mockResolvedValue({
    text: '<svg id="external"/>',
    version: "v3",
    readOnly: false,
  });
  await model.open("image.svg");
  await screen.findByAltText("image.svg");
  expect(model.current()?.text).toBe(`${edited}\n`);
  expect(model.current()?.problem).toBe("conflict");
  expect(
    screen.getByRole("button", { name: "저장" }).hasAttribute("disabled"),
  ).toBe(true);
  await userEvent.click(
    screen.getByRole("button", { name: "디스크에서 다시 읽기" }),
  );
  await userEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "디스크에서 다시 읽기",
    }),
  );
  expect(model.current()?.text).toBe('<svg id="external"/>');
  expect(model.pending()).toHaveLength(0);
});

it("connects image refresh, moves, deletion and panel visibility to the preview lifecycle", async () => {
  let model!: FilesModel;
  const [visible, setVisible] = createSignal(true);
  render(() => (
    <I18nProvider>
      <Fixture
        visible={visible()}
        onModel={(value) => {
          model = value;
        }}
      />
    </I18nProvider>
  ));
  await model.open("folder/image.png");
  await screen.findByAltText("folder/image.png");
  const first = screen.getByAltText("folder/image.png").getAttribute("src");
  await model.update({
    type: "changed",
    changed: ["folder/image.png"],
    removed: [],
    entries: [],
    warnings: [],
  });
  await waitFor(() =>
    expect(
      screen.getByAltText("folder/image.png").getAttribute("src"),
    ).not.toBe(first),
  );
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
  await model.operation({ type: "move", from: "folder", to: "renamed" });
  await screen.findByAltText("renamed/image.png");
  expect(readImage).toHaveBeenLastCalledWith("thread", "renamed/image.png");
  setVisible(false);
  expect(screen.queryByAltText("renamed/image.png")).toBeNull();
  setVisible(true);
  await screen.findByAltText("renamed/image.png");
  vi.mocked(readImage).mockRejectedValueOnce("missing");
  await model.update({
    type: "changed",
    changed: [],
    removed: ["renamed/image.png"],
    entries: [],
    warnings: [],
  });
  await screen.findByText("이미지가 없거나 읽을 수 없습니다.");
  expect(screen.queryByAltText("renamed/image.png")).toBeNull();
  await model.operation({ type: "trash", path: "renamed" });
  expect(model.selected()).toBeUndefined();
});

function Fixture(props: {
  onModel?: (model: FilesModel) => void;
  visible?: boolean;
}) {
  const manager = createFilesManager((key) => key);
  const model = manager.get("thread");
  props.onModel?.(model);
  return (
    <>
      <WorkspaceFiles
        model={model}
        manager={manager}
        visible={props.visible ?? true}
      />
      <FilesDialogs manager={manager} />
    </>
  );
}
