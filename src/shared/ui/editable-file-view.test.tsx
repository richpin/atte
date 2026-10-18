import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { EditableFile } from "./editable-file-view";

const fixtures = vi.hoisted(() => ({
  editors: [] as {
    options: {
      onAttach?: (editor: unknown) => void;
      onChange?: (event: { file: { contents: string } }) => void;
    };
    ready: boolean;
    restored: unknown;
    cleanUp: ReturnType<typeof vi.fn>;
    setViewState: (view: unknown) => void;
  }[],
}));
vi.mock("@pierre/diffs", () => ({
  getFiletypeFromFileName: () => "text",
  getSharedHighlighter: async () => undefined,
  Virtualizer: class {
    setup() {}
    cleanUp() {}
    markDOMDirty() {}
  },
  VirtualizedFile: class {
    render() {}
    cleanUp() {}
    setThemeType() {}
  },
}));
vi.mock("@pierre/diffs/edit", () => ({
  Editor: class {
    ready = false;
    restored: unknown;
    cleanUp = vi.fn();
    constructor(
      _type: unknown,
      readonly options: (typeof fixtures.editors)[number]["options"],
    ) {
      fixtures.editors.push(this);
    }
    edit() {}
    getViewState() {
      return { view: { scrollTop: 20, scrollLeft: 3 } };
    }
    setViewState(view: unknown) {
      if (!this.ready) throw new Error("Editor not attached");
      this.restored = view;
    }
  },
}));
afterEach(() => {
  cleanup();
  fixtures.editors.length = 0;
});
it("restores the cursor and viewport only after the new editor has attached", async () => {
  const [path, setPath] = createSignal("original.ts");
  const onError = vi.fn();
  render(() => (
    <EditableFile
      path={path()}
      text="content"
      revision={0}
      readOnly={false}
      visible
      onChange={() => undefined}
      onError={onError}
    />
  ));
  await waitFor(() => expect(fixtures.editors).toHaveLength(1));
  setPath("renamed.ts");
  await waitFor(() => expect(fixtures.editors).toHaveLength(2));
  const editor = fixtures.editors[1];
  expect(editor.restored).toBeUndefined();
  editor.ready = true;
  editor.options.onAttach?.(editor);
  expect(editor.restored).toEqual({ view: { scrollTop: 20, scrollLeft: 3 } });
  expect(fixtures.editors[0].cleanUp).toHaveBeenCalledWith("discard");
  expect(onError).not.toHaveBeenCalled();
});
it("does not recreate an editor when saving replaces metadata without changing read-only status", async () => {
  const [disk, setDisk] = createSignal({ readOnly: false, version: "first" });
  const change = vi.fn();
  render(() => (
    <EditableFile
      path="file"
      text="original"
      revision={0}
      readOnly={disk().readOnly}
      visible
      onChange={change}
      onError={() => undefined}
    />
  ));
  await waitFor(() => expect(fixtures.editors).toHaveLength(1));
  setDisk({ readOnly: false, version: "second" });
  fixtures.editors[0].options.onChange?.({ file: { contents: "edited" } });
  expect(fixtures.editors).toHaveLength(1);
  expect(change).toHaveBeenCalledWith("edited");
});
