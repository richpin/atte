import type {
  FileTree,
  FileTreeBatchOperation,
  FileTreeMutationEvent,
  FileTreePreparedInput,
} from "@pierre/trees";

// Track Pierre's optimistic moves as well as the authoritative disk snapshots.
export function createTreePathSync(tree: FileTree) {
  let paths = new Set<string>();
  let initialized = false;
  let updating = false;
  let pending: FileTreeMutationEvent[] = [];
  const contains = (parent: string, path: string) =>
    path === parent || (parent.endsWith("/") && path.startsWith(parent));
  const record = (event: FileTreeMutationEvent) => {
    if (updating) {
      pending.push(event);
      return;
    }
    switch (event.operation) {
      case "batch":
        for (const child of event.events) record(child);
        break;
      case "add":
        paths.add(event.path);
        break;
      case "remove":
        if (!event.path.endsWith("/")) paths.delete(event.path);
        else
          for (const path of paths)
            if (contains(event.path, path)) paths.delete(path);
        break;
      case "move":
        paths = new Set(
          [...paths].map((path) =>
            contains(event.from, path)
              ? event.to + path.slice(event.from.length)
              : path,
          ),
        );
        break;
    }
  };
  const dispose = tree.onMutation("*", record);
  return {
    get initialized() {
      return initialized;
    },
    has(path: string) {
      return paths.has(path) || paths.has(`${path}/`);
    },
    initialize(prepared: FileTreePreparedInput) {
      if (initialized) return;
      tree.resetPaths({ preparedInput: prepared });
      paths = new Set(prepared.paths);
      initialized = true;
    },
    update(nextPaths: readonly string[]) {
      const next = new Set(nextPaths);
      const removed = new Set([...paths].filter((path) => !next.has(path)));
      const operations: FileTreeBatchOperation[] = [];
      for (const path of removed) {
        // Removing a directory already removes its descendants.
        const segments = path.replace(/\/$/, "").split("/");
        if (
          segments
            .slice(0, -1)
            .some((_, index) =>
              removed.has(`${segments.slice(0, index + 1).join("/")}/`),
            )
        )
          continue;
        operations.push({
          type: "remove",
          path,
          recursive: path.endsWith("/"),
        });
      }
      for (const path of next)
        if (!paths.has(path)) operations.push({ type: "add", path });
      if (!operations.length) return false;
      // A successful batch already has its complete next snapshot. Avoid a
      // full mirror traversal for every individual directory removal.
      updating = true;
      try {
        tree.batch(operations);
        paths = next;
      } catch (error) {
        updating = false;
        for (const event of pending) record(event);
        throw error;
      } finally {
        updating = false;
        pending = [];
      }
      return true;
    },
    dispose,
  };
}
