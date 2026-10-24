import { FileTree as PierreTree, prepareFileTreeInput } from "@pierre/trees";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileTree } from "./file-tree";

const renderTree = PierreTree.prototype.render;
let tree: PierreTree;
beforeEach(() => {
  // Keep Pierre's real model and callbacks; omit only the web-component renderer.
  vi.spyOn(PierreTree.prototype, "render").mockImplementation(function (
    this: PierreTree,
  ) {
    tree = this;
  });
  vi.stubGlobal(
    "Worker",
    class {
      onmessage?: (event: { data: unknown }) => void;
      postMessage({ id, paths }: { id: number; paths: string[] }) {
        queueMicrotask(() =>
          this.onmessage?.({
            data: { id, prepared: prepareFileTreeInput(paths) },
          }),
        );
      }
      terminate() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([0, 10000])(
  "prepares the first disk snapshot of %i entries in the worker even when it arrives after mount",
  async (count) => {
    const [entries, setEntries] = createSignal<
      { path: string; directory: boolean }[]
    >([]);
    const [loading, setLoading] = createSignal(true);
    const fixture = render(() => (
      <FileTree
        entries={entries()}
        loading={loading()}
        dirtyPaths={[]}
        dirtyLabel="Unsaved"
        disabled={false}
        labels={{
          newFile: "New file",
          newFolder: "New folder",
          rename: "Rename",
          trash: "Trash",
        }}
        onSelect={() => {}}
        onAction={() => {}}
        onMove={async () => true}
        onError={(error) => {
          throw error;
        }}
      />
    ));
    await waitFor(() => expect(PierreTree.prototype.render).toHaveBeenCalled());
    // Let the empty-list worker response arrive before the filesystem snapshot.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const batch = vi.spyOn(tree, "batch");
    const reset = vi.spyOn(tree, "resetPaths");
    setEntries(
      Array.from({ length: count }, (_, index) => ({
        path: `build/file-${index}.o`,
        directory: false,
      })),
    );
    setLoading(false);
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    if (count) expect(tree.getItem(`build/file-${count - 1}.o`)).toBeTruthy();
    expect(batch).not.toHaveBeenCalled();
    // Refreshing an initialized tree keeps its controller and applies only the delta.
    setLoading(true);
    setEntries((previous) => [
      ...previous,
      { path: "new.txt", directory: false },
    ]);
    setLoading(false);
    expect(tree.getItem("new.txt")).toBeTruthy();
    expect(reset).toHaveBeenCalledTimes(1);
    fixture.unmount();
  },
);

it("converts real Pierre directory selections and menu actions to Atte paths", async () => {
  const onSelect = vi.fn();
  const onAction = vi.fn();
  render(() => (
    <FileTree
      entries={[
        { path: "src", directory: true },
        { path: "src/app.ts", directory: false },
      ]}
      dirtyPaths={[]}
      dirtyLabel="Unsaved"
      disabled={false}
      labels={{
        newFile: "New file",
        newFolder: "New folder",
        rename: "Rename",
        trash: "Trash",
      }}
      onSelect={onSelect}
      onAction={onAction}
      onMove={async () => true}
      onError={(error) => {
        throw error;
      }}
    />
  ));
  await waitFor(() => expect(tree?.getItem("src")).toBeTruthy());
  expect(tree.getItem("src")?.getPath()).toBe("src/");
  tree.getItem("src")?.select();
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith("src", true));
  tree.getItem("src/app.ts")?.select();
  await waitFor(() =>
    expect(onSelect).toHaveBeenCalledWith("src/app.ts", false),
  );

  const close = vi.fn();
  const renderMenu = tree.getComposition()?.contextMenu?.render;
  expect(renderMenu).toBeTypeOf("function");
  const menu = renderMenu?.(
    { path: "src/", name: "src", kind: "directory" },
    {
      close,
      anchorElement: document.createElement("button"),
      anchorRect: new DOMRect(),
      restoreFocus: vi.fn(),
    },
  );
  expect(menu).toBeInstanceOf(HTMLElement);
  const buttons = (menu as HTMLElement).querySelectorAll("button");
  buttons[0].click();
  expect(onAction).toHaveBeenCalledWith("newFile", "src", true);
  buttons[3].click();
  expect(onAction).toHaveBeenCalledWith("trash", "src", true);
});

it.each<[string, string | null, string, boolean]>([
  ["source.txt", "target/", "target/source.txt", true],
  ["folder/", "target/", "target/folder", true],
  ["nested/source.txt", null, "source.txt", true],
  ["nested/folder/", null, "folder", true],
  ["source.txt", "target/", "target/source.txt", false],
  ["folder/", "target/", "target/folder", false],
  ["nested/source.txt", null, "source.txt", false],
  ["nested/folder/", null, "folder", false],
])(
  "moves %s into %s as %s (disk success: %s) without resetting",
  async (source, target, destination, succeeds) => {
    vi.mocked(PierreTree.prototype.render).mockImplementation(function (
      this: PierreTree,
      props,
    ) {
      tree = this;
      renderTree.call(this, props);
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const onMove = vi.fn(async () => succeeds);
    const onError = vi.fn();
    const fixture = render(() => (
      <FileTree
        entries={[
          { path: "target", directory: true },
          { path: source.replace(/\/$/, ""), directory: source.endsWith("/") },
          ...(source.endsWith("/")
            ? [{ path: `${source}child.txt`, directory: false }]
            : []),
          ...(target ? [{ path: "anchor.txt", directory: false }] : []),
          { path: "nested", directory: true },
          { path: "nested/anchor.txt", directory: false },
        ]}
        dirtyPaths={[]}
        dirtyLabel="Unsaved"
        disabled={false}
        labels={{
          newFile: "New file",
          newFolder: "New folder",
          rename: "Rename",
          trash: "Trash",
        }}
        onSelect={() => undefined}
        onAction={() => undefined}
        onMove={onMove}
        onError={onError}
      />
    ));
    let shadow!: ShadowRoot;
    await waitFor(() => {
      shadow = fixture.container.querySelector("file-tree-container")
        ?.shadowRoot as ShadowRoot;
      expect(shadow?.querySelector('[data-item-path="nested/"]')).toBeTruthy();
    });
    const nested = shadow.querySelector(
      '[data-item-path="nested/"]',
    ) as HTMLElement;
    if (source.startsWith("nested/")) fireEvent.click(nested);
    let row!: HTMLElement;
    await waitFor(() => {
      row = shadow.querySelector(`[data-item-path="${source}"]`) as HTMLElement;
      expect(row).toBeTruthy();
    });
    const reset = vi.spyOn(tree, "resetPaths");
    const directory = source.endsWith("/") ? tree.getItem(source) : null;
    if (directory && "expand" in directory) {
      directory.expand();
      await waitFor(() =>
        expect(
          shadow.querySelector(`[data-item-path="${source}child.txt"]`),
        ).toBeTruthy(),
      );
    }
    const dropTarget = target
      ? (shadow.querySelector(`[data-item-path="${target}"]`) as HTMLElement)
      : (shadow.querySelector('[role="tree"]') as HTMLElement);
    Object.defineProperty(shadow, "elementFromPoint", {
      value: () => dropTarget,
      configurable: true,
    });
    const dataTransfer = {
      getData: vi.fn(() => source),
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    };
    if (!target) {
      fireEvent.drop(dropTarget, { dataTransfer });
      expect(onMove).not.toHaveBeenCalled();
    }
    fireEvent.dragStart(row, { dataTransfer, composed: true });
    fireEvent.dragOver(dropTarget, {
      dataTransfer,
      clientX: 1,
      clientY: 1,
      composed: true,
    });
    fireEvent.drop(dropTarget, {
      dataTransfer,
      clientX: 1,
      clientY: 1,
      composed: true,
    });
    await waitFor(() =>
      expect(onMove).toHaveBeenCalledWith(
        source.replace(/\/$/, ""),
        destination,
      ),
    );
    const result = succeeds ? destination : source.replace(/\/$/, "");
    await waitFor(() => expect(tree.getItem(result)).toBeTruthy());
    if (source.endsWith("/")) {
      const moved = tree.getItem(result);
      expect(moved && "isExpanded" in moved && moved.isExpanded()).toBe(true);
      expect(tree.getItem(`${result}/child.txt`)).toBeTruthy();
    }
    expect(reset).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  },
);

it("preserves typed capitals while searching paths without case sensitivity", async () => {
  vi.mocked(PierreTree.prototype.render).mockImplementation(function (
    this: PierreTree,
    props,
  ) {
    tree = this;
    renderTree.call(this, props);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const fixture = render(() => (
    <FileTree
      entries={[
        { path: "App.ts", directory: false },
        { path: "app.test.ts", directory: false },
      ]}
      dirtyPaths={[]}
      dirtyLabel="Unsaved"
      disabled={false}
      labels={{
        newFile: "New file",
        newFolder: "New folder",
        rename: "Rename",
        trash: "Trash",
      }}
      onSelect={() => undefined}
      onAction={() => undefined}
      onMove={async () => true}
      onError={(error) => {
        throw error;
      }}
    />
  ));
  let input!: HTMLInputElement;
  await waitFor(() => {
    input = fixture.container
      .querySelector("file-tree-container")
      ?.shadowRoot?.querySelector("input") as HTMLInputElement;
    expect(input).toBeTruthy();
  });
  for (const query of ["APP", "app", "App"]) {
    fireEvent.input(input, { target: { value: query } });
    await waitFor(() => expect(tree.getSearchValue()).toBe(query));
    await waitFor(() => expect(input.value).toBe(query));
    expect(tree.getSearchMatchingPaths().toSorted()).toEqual([
      "App.ts",
      "app.test.ts",
    ]);
  }
  tree.setSearch("APP");
  await waitFor(() => expect(input.value).toBe("APP"));
  tree.closeSearch();
  await waitFor(() => expect(input.value).toBe(""));
});

it("replaces and clears controlled selection without rebuilding or echoing selection events", async () => {
  const [selectedPath, setSelectedPath] = createSignal<string | undefined>(
    "old.ts",
  );
  const onSelect = vi.fn();
  render(() => (
    <FileTree
      entries={[
        { path: "old.ts", directory: false },
        { path: "new.ts", directory: false },
        { path: "folder", directory: true },
      ]}
      selectedPath={selectedPath()}
      dirtyPaths={[]}
      dirtyLabel="Unsaved"
      disabled={false}
      labels={{
        newFile: "New file",
        newFolder: "New folder",
        rename: "Rename",
        trash: "Trash",
      }}
      onSelect={onSelect}
      onAction={() => undefined}
      onMove={async () => true}
      onError={(error) => {
        throw error;
      }}
    />
  ));
  await waitFor(() => expect(tree.getSelectedPaths()).toEqual(["old.ts"]));
  const reset = vi.spyOn(tree, "resetPaths");
  setSelectedPath("new.ts");
  await waitFor(() => expect(tree.getSelectedPaths()).toEqual(["new.ts"]));
  // A queued native selection must not overwrite a newer application selection.
  tree.getItem("old.ts")?.select();
  setSelectedPath("folder");
  await waitFor(() => expect(tree.getSelectedPaths()).toEqual(["folder/"]));
  setSelectedPath(undefined);
  await waitFor(() => expect(tree.getSelectedPaths()).toEqual([]));
  expect(reset).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
});

it.each(["before", "after"])(
  "selects a created file when the initial Worker reply arrives %s the entries change",
  async (order) => {
    const replies: (() => void)[] = [];
    vi.stubGlobal(
      "Worker",
      class {
        onmessage?: (event: { data: unknown }) => void;
        postMessage({ id, paths }: { id: number; paths: string[] }) {
          replies.push(() =>
            this.onmessage?.({
              data: { id, prepared: prepareFileTreeInput(paths) },
            }),
          );
        }
        terminate() {}
      },
    );
    const [entries, setEntries] = createSignal([
      { path: "old.ts", directory: false },
    ]);
    const [selectedPath, setSelectedPath] = createSignal("old.ts");
    const onSelect = vi.fn();
    render(() => (
      <FileTree
        entries={entries()}
        selectedPath={selectedPath()}
        dirtyPaths={[]}
        dirtyLabel="Unsaved"
        disabled={false}
        labels={{
          newFile: "New file",
          newFolder: "New folder",
          rename: "Rename",
          trash: "Trash",
        }}
        onSelect={onSelect}
        onAction={() => undefined}
        onMove={async () => true}
        onError={(error) => {
          throw error;
        }}
      />
    ));
    await waitFor(() =>
      expect(PierreTree.prototype.render).toHaveBeenCalledTimes(1),
    );
    if (order === "before") {
      replies.shift()?.();
      expect(tree.getSelectedPaths()).toEqual(["old.ts"]);
    }
    setEntries([...entries(), { path: "created.ts", directory: false }]);
    setSelectedPath("created.ts");
    if (order === "after") {
      await waitFor(() => expect(replies).toHaveLength(2));
      replies.shift()?.(); // Ignore the obsolete initial snapshot.
      replies.shift()?.();
    }
    expect(replies).toHaveLength(0);
    await waitFor(() =>
      expect(tree.getSelectedPaths()).toEqual(["created.ts"]),
    );
    expect(onSelect).not.toHaveBeenCalled();
  },
);

it("updates dirty decorations without resetting paths or losing tree state", async () => {
  vi.mocked(PierreTree.prototype.render).mockImplementation(function (
    this: PierreTree,
    props,
  ) {
    tree = this;
    renderTree.call(this, props);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const [dirtyPaths, setDirtyPaths] = createSignal<string[]>([]);
  const fixture = render(() => (
    <FileTree
      entries={[
        { path: "src", directory: true },
        { path: "src/app.ts", directory: false },
      ]}
      selectedPath="src/app.ts"
      dirtyPaths={dirtyPaths()}
      dirtyLabel="Unsaved"
      disabled={false}
      labels={{
        newFile: "New file",
        newFolder: "New folder",
        rename: "Rename",
        trash: "Trash",
      }}
      onSelect={() => undefined}
      onAction={() => undefined}
      onMove={async () => true}
      onError={(error) => {
        throw error;
      }}
    />
  ));
  await waitFor(() => expect(tree.getItem("src/app.ts")).toBeTruthy());
  const directory = tree.getItem("src");
  if (!directory || !("expand" in directory))
    throw new Error("Expected directory");
  directory.expand();
  tree.focusPath("src/app.ts");
  tree.setSearch("App");
  const reset = vi.spyOn(tree, "resetPaths");
  const batch = vi.spyOn(tree, "batch");
  const shadow = fixture.container.querySelector(
    "file-tree-container",
  )?.shadowRoot;
  setDirtyPaths(["src/app.ts"]);
  await waitFor(() =>
    expect(shadow?.querySelector('[title="Unsaved"]')).toBeTruthy(),
  );
  setDirtyPaths([]);
  await waitFor(() =>
    expect(shadow?.querySelector('[title="Unsaved"]')).toBeNull(),
  );
  expect(reset).not.toHaveBeenCalled();
  expect(batch).not.toHaveBeenCalled();
  expect(tree.getItem("src")).toBe(directory);
  expect(directory.isExpanded()).toBe(true);
  expect(tree.getSelectedPaths()).toEqual(["src/app.ts"]);
  expect(tree.getFocusedPath()).toBe("src/app.ts");
  expect(tree.getSearchValue()).toBe("App");
});
