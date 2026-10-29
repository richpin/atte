import type { FileTreePreparedInput, FileTree as Tree } from "@pierre/trees";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import { createTreePathSync } from "./file-tree-paths";

export type TreeAction = "newFile" | "newFolder" | "rename" | "trash";
export type TreeItem = { path: string; directory: boolean };
// Pierre marks directories with a trailing slash; Atte stores relative paths without it.
const fromTreePath = (path: string) => path.replace(/\/$/, "");
export function FileTree(props: {
  entries: readonly TreeItem[];
  loading?: boolean;
  directoryStatus?: Record<string, "loading" | "error">;
  loadingLabel?: string;
  errorLabel?: string;
  dirtyPaths: readonly string[];
  selectedPath?: string;
  dirtyLabel: string;
  disabled: boolean;
  labels: Record<TreeAction, string>;
  onSelect: (path: string, directory: boolean) => void;
  onExpand?: (path: string) => void;
  onSearchChange?: (query: string) => void;
  onAction: (
    action: Exclude<TreeAction, "rename">,
    path: string,
    directory: boolean,
  ) => void;
  onMove: (from: string, to: string) => Promise<boolean>;
  onError: (error: unknown) => void;
}) {
  let container!: HTMLDivElement;
  let tree: Tree | undefined;
  let worker: Worker;
  let revision = 0;
  let dead = false;
  let prepared: FileTreePreparedInput | undefined;
  let pathSync: ReturnType<typeof createTreePathSync> | undefined;
  let unsubscribeTree: (() => void) | undefined;
  let latestPaths: readonly string[] = [];
  const dirtyPaths = createMemo(() => new Set(props.dirtyPaths));
  let applying = false;
  let selectionRevision = 0;
  let draggedPath: string | undefined;
  const [rootHovered, setRootHovered] = createSignal(false);
  const canDropAtRoot = () => !props.disabled && !!draggedPath?.includes("/");
  const syncSelection = (path: string | undefined) => {
    ++selectionRevision;
    if (!tree) return;
    const target = path && pathSync?.has(path) ? tree.getItem(path) : null;
    const wasApplying = applying;
    applying = true;
    try {
      if (target && path) {
        const segments = path.split("/");
        for (let index = 1; index < segments.length; index++) {
          const parent = tree.getItem(segments.slice(0, index).join("/"));
          if (parent && "expand" in parent && !parent.isExpanded())
            parent.expand();
        }
      }
      for (const selected of tree.getSelectedPaths()) {
        if (selected !== target?.getPath()) tree.getItem(selected)?.deselect();
      }
      target?.select();
    } finally {
      applying = wasApplying;
    }
  };
  const initialize = () => {
    if (!tree || !prepared || !pathSync || pathSync.initialized) return;
    applying = true;
    try {
      pathSync.initialize(prepared);
      prepared = undefined;
      worker.terminate();
      syncSelection(props.selectedPath);
    } finally {
      applying = false;
    }
  };
  const reconcile = () => {
    if (!pathSync?.initialized) return;
    const wasApplying = applying;
    applying = true;
    try {
      if (pathSync.update(latestPaths)) syncSelection(props.selectedPath);
    } catch (error) {
      props.onError(error);
    } finally {
      applying = wasApplying;
    }
  };
  const persistMove = async (from: string, to: string) => {
    let moved = false;
    try {
      moved = await props.onMove(from, to);
    } catch (error) {
      props.onError(error);
    }
    if (dead || moved) return;
    const wasApplying = applying;
    applying = true;
    try {
      const destination = pathSync?.has(to) ? tree?.getItem(to) : null;
      if (tree && destination && !pathSync?.has(from)) {
        tree.move(
          destination.getPath(),
          from + (destination.isDirectory() ? "/" : ""),
        );
      }
      reconcile();
      syncSelection(props.selectedPath);
    } catch (error) {
      props.onError(error);
    } finally {
      applying = wasApplying;
    }
  };
  onMount(() => {
    // Drag events cross Pierre's shadow boundary. Use standard interactive roles
    // to leave row/search/menu drops to Pierre and handle only the empty surface.
    const isEmptySurface = (event: DragEvent) =>
      !event
        .composedPath()
        .some(
          (node) =>
            node instanceof Element &&
            node.matches(
              'button, input, textarea, select, a, [role="treeitem"], [role="menu"], [role="menuitem"]',
            ),
        );
    const startDrag = (event: DragEvent) => {
      const host = tree?.getFileTreeContainer();
      if (!host || !event.composedPath().includes(host)) return;
      draggedPath = undefined;
      if (event.defaultPrevented || props.disabled) return;
      const path = event.dataTransfer?.getData("text/plain");
      if (path && tree?.getItem(path)) draggedPath = fromTreePath(path);
    };
    const endDrag = () => {
      draggedPath = undefined;
      setRootHovered(false);
    };
    const dragOver = (event: DragEvent) => {
      const allowed = canDropAtRoot() && isEmptySurface(event);
      setRootHovered(allowed);
      if (!allowed) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    };
    const drop = (event: DragEvent) => {
      if (!canDropAtRoot() || !draggedPath || !isEmptySurface(event)) return;
      event.preventDefault();
      const from = draggedPath;
      endDrag();
      const to = from.split("/").at(-1);
      const source = tree?.getItem(from);
      if (!tree || !to || !source) return;
      applying = true;
      try {
        tree.move(source.getPath(), to + (source.isDirectory() ? "/" : ""));
        void persistMove(from, to);
      } catch (error) {
        props.onError(error);
      } finally {
        applying = false;
      }
    };
    const leave = () => setRootHovered(false);
    container.addEventListener("dragstart", startDrag);
    container.addEventListener("dragend", endDrag);
    container.addEventListener("dragover", dragOver);
    container.addEventListener("drop", drop);
    container.addEventListener("dragleave", leave);
    onCleanup(() => {
      container.removeEventListener("dragstart", startDrag);
      container.removeEventListener("dragend", endDrag);
      container.removeEventListener("dragover", dragOver);
      container.removeEventListener("drop", drop);
      container.removeEventListener("dragleave", leave);
    });
    worker = new Worker(new URL("./file-tree-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (
      event: MessageEvent<{
        id: number;
        prepared?: FileTreePreparedInput;
        error?: string;
      }>,
    ) => {
      if (event.data.id !== revision || dead) return;
      if (!event.data.prepared) {
        props.onError(event.data.error);
        return;
      }
      prepared = event.data.prepared;
      initialize();
    };
    worker.onerror = (event) =>
      props.onError(event.message || "File tree preparation failed");
    void import("@pierre/trees")
      .then(({ FileTree: PierreTree }) => {
        if (dead) return;
        tree = new PierreTree({
          paths: [],
          initialExpansion: "closed",
          search: true,
          searchBlurBehavior: "retain",
          onSearchChange: (query) => props.onSearchChange?.(query ?? ""),
          unsafeCSS: "[data-file-tree-search-input] { min-width: 0; }",
          icons: { set: "complete", colored: true },
          density: "compact",
          onSelectionChange: (paths) => {
            if (applying) return;
            const request = ++selectionRevision;
            const path = paths.at(-1);
            if (path)
              queueMicrotask(() => {
                if (
                  !dead &&
                  !props.disabled &&
                  !applying &&
                  request === selectionRevision
                )
                  props.onSelect(
                    fromTreePath(path),
                    tree?.getItem(path)?.isDirectory() ?? false,
                  );
              });
          },
          renaming: {
            canRename: () => !props.disabled,
            onRename: (event) => {
              void persistMove(
                fromTreePath(event.sourcePath),
                fromTreePath(event.destinationPath),
              );
            },
            onError: props.onError,
          },
          dragAndDrop: {
            canDrag: (paths) => !props.disabled && paths.length === 1,
            canDrop: () => !props.disabled,
            onDropComplete: (event) => {
              const source = event.draggedPaths[0];
              if (!source) return;
              const from = fromTreePath(source);
              const parent = fromTreePath(event.target.directoryPath ?? "");
              const to = [parent, from.split("/").at(-1)]
                .filter(Boolean)
                .join("/");
              void persistMove(from, to);
            },
            onDropError: props.onError,
          },
          renderRowDecoration: ({ item }) => {
            const status = props.directoryStatus?.[fromTreePath(item.path)];
            if (status === "loading")
              return { text: "…", title: props.loadingLabel };
            if (status === "error")
              return { text: "!", title: props.errorLabel };
            return dirtyPaths().has(item.path)
              ? { text: "●", title: props.dirtyLabel }
              : null;
          },
          composition: {
            contextMenu: {
              enabled: true,
              render: (item, context) => {
                const menu = document.createElement("div");
                menu.setAttribute("role", "menu");
                menu.setAttribute("aria-label", item.name);
                menu.className =
                  "grid w-max min-w-44 rounded-xl border border-line bg-menu p-1 text-xs text-ink shadow-md";
                const buttons: HTMLButtonElement[] = [];
                for (const action of [
                  "newFile",
                  "newFolder",
                  "rename",
                  "trash",
                ] as const) {
                  const button = document.createElement("button");
                  button.type = "button";
                  button.setAttribute("role", "menuitem");
                  button.textContent = props.labels[action];
                  button.disabled = props.disabled;
                  button.className =
                    "whitespace-nowrap rounded-lg px-2 py-1.5 text-left outline-none hover:bg-menu-hover focus-visible:bg-menu-hover disabled:pointer-events-none disabled:opacity-50";
                  button.onclick = () => {
                    context.close({ restoreFocus: action !== "rename" });
                    if (action === "rename") tree?.startRenaming(item.path);
                    else
                      props.onAction(
                        action,
                        fromTreePath(item.path),
                        item.kind === "directory",
                      );
                  };
                  menu.append(button);
                  buttons.push(button);
                }
                menu.onkeydown = (event) => {
                  const index = buttons.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    buttons[
                      (index +
                        (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
                        buttons.length
                    ]?.focus();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    context.close();
                  }
                };
                queueMicrotask(() => buttons[0]?.focus());
                return menu;
              },
            },
          },
        });
        pathSync = createTreePathSync(tree);
        tree.render({ containerWrapper: container });
        let expanded = new Set<string>();
        unsubscribeTree = tree.subscribe(() => {
          if (!tree || tree.getSearchValue()) return;
          const next = new Set<string>();
          for (const row of tree.getVisibleRows(0, tree.getVisibleCount())) {
            if (row.kind !== "directory" || !row.isExpanded) continue;
            const path = fromTreePath(row.path);
            next.add(path);
            if (!expanded.has(path)) props.onExpand?.(path);
          }
          expanded = next;
        });
        initialize();
      })
      .catch(props.onError);
    onCleanup(() => {
      dead = true;
      unsubscribeTree?.();
      worker.terminate();
      pathSync?.dispose();
      tree?.cleanUp();
    });
  });
  createEffect(() => {
    // The mount-time empty list is not the initial filesystem snapshot. Keep
    // the worker alive so that snapshot does not become a large batch of adds.
    if (props.loading && !pathSync?.initialized) return;
    const paths = new Set<string>();
    for (const entry of props.entries) {
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index++) {
        paths.add(`${segments.slice(0, index).join("/")}/`);
      }
      paths.add(entry.path + (entry.directory ? "/" : ""));
    }
    latestPaths = [...paths];
    if (pathSync?.initialized) untrack(reconcile);
    else {
      prepared = undefined;
      // Effects run after onMount has created the worker.
      worker?.postMessage({ id: ++revision, paths: latestPaths });
    }
  });
  createEffect(() => {
    syncSelection(props.selectedPath);
  });
  createEffect(() => {
    dirtyPaths();
    props.dirtyLabel;
    props.directoryStatus;
    // Re-render visible decorations without touching paths or controller state.
    untrack(() => tree?.render({ containerWrapper: container }));
  });
  return (
    <div
      ref={container}
      class="h-full min-h-0 overflow-hidden pt-2"
      classList={{ "outline outline-accent -outline-offset-1": rootHovered() }}
      style={{
        "--trees-bg-override": "var(--color-canvas)",
        "--trees-fg-override": "var(--color-ink)",
        "--trees-fg-muted-override": "var(--color-muted)",
        "--trees-bg-muted-override": "var(--color-panel)",
        "--trees-input-bg-override": "var(--color-input-surface)",
        "--trees-search-bg-override": "var(--color-input-surface)",
        "--trees-search-fg-override": "var(--color-ink)",
        "--trees-scrollbar-gutter-override": "4px",
        "--trees-scrollbar-thumb-override":
          "color-mix(in srgb, var(--color-ink) 22%, transparent)",
        "--trees-accent-override": "var(--color-accent)",
        "--trees-focus-ring-color-override": "var(--color-accent)",
        "--trees-selected-fg-override": "var(--color-ink)",
        "--trees-selected-focused-border-color-override": "var(--color-accent)",
        "--trees-indent-guide-bg-override": "var(--color-line)",
        "--trees-border-color-override": "var(--color-line)",
        "--trees-selected-bg-override": "var(--color-panel)",
      }}
    />
  );
}
