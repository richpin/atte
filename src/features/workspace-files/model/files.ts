import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  closeSearch,
  type DirectoryListing,
  type DiskFile,
  type FileEntry,
  type FileUpdate,
  listDirectory,
  operateFile,
  readFile,
  saveFile,
  searchPaths,
} from "../api/files";
import { imageMime } from "../lib/file-kind";

export type Draft = {
  id: string;
  path: string;
  disk: DiskFile;
  text: string;
  external?: DiskFile;
  problem?: string;
  saving: boolean;
  revision: number;
};
export const dirty = (draft: Draft) => draft.text !== draft.disk.text;
export const within = (path: string, parent: string) =>
  parent === "" || path === parent || path.startsWith(`${parent}/`);
export function treeWidth(
  width: number,
  anchorWidth: number,
  anchorTree: number,
) {
  return Math.max(
    100,
    Math.min(width - 160, anchorTree + (width - anchorWidth) * 0.2),
  );
}
export function createFilesModel(threadId: string) {
  const [entries, setEntries] = createSignal<FileEntry[]>([]);
  const [drafts, setDrafts] = createStore<Record<string, Draft>>({});
  const [selected, setSelected] = createSignal<string>();
  const [error, setError] = createSignal<unknown>();
  const [openError, setOpenError] = createSignal<unknown>();
  const [warnings, setWarnings] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [generation, setGeneration] = createSignal(0);
  const [imageRevision, setImageRevision] = createSignal(0);
  const [searchResults, setSearchResults] = createSignal<FileEntry[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [directoryErrors, setDirectoryErrors] = createSignal<
    Record<string, string>
  >({});
  const [loadingDirectories, setLoadingDirectories] = createSignal<string[]>(
    [],
  );
  const loaded = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const directoryRevisions = new Map<string, number>();
  const refreshAgain = new Set<string>();
  const directoryWarnings = new Map<string, string[]>();
  let searchId: string | undefined;
  let searchRevision = 0;
  let currentQuery = "";
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const reads = new Map<string, number>();
  let disposed = false;
  const deferredUpdates: FileUpdate[] = [];
  const pending = () => Object.values(drafts).filter(dirty);
  const draftAt = (path: string) =>
    Object.values(drafts).find((draft) => draft.path === path);
  const current = () => {
    const path = selected();
    return path && !imageMime(path) ? draftAt(path) : undefined;
  };
  const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
  function applyDirectory(path: string, listing: DirectoryListing) {
    const previous = entries();
    const children = new Map(
      listing.entries.map((entry) => [entry.path, entry]),
    );
    const removed = previous
      .filter(
        (entry) =>
          parentOf(entry.path) === path &&
          (!children.has(entry.path) ||
            children.get(entry.path)?.directory !== entry.directory),
      )
      .map((entry) => entry.path);
    const removedSet = new Set(removed);
    const isRemoved = (candidate: string) => {
      for (let current = candidate; current; current = parentOf(current)) {
        if (removedSet.has(current)) return true;
      }
      return false;
    };
    const next = new Map(
      previous
        .filter((entry) => !isRemoved(entry.path))
        .map((entry) => [entry.path, entry]),
    );
    for (const entry of listing.entries) next.set(entry.path, entry);
    for (const item of removed) {
      for (const directory of loaded) {
        if (within(directory, item)) loaded.delete(directory);
      }
      for (const directory of directoryRevisions.keys()) {
        if (within(directory, item)) {
          directoryRevisions.set(
            directory,
            (directoryRevisions.get(directory) ?? 0) + 1,
          );
        }
      }
      for (const directory of directoryWarnings.keys()) {
        if (within(directory, item)) directoryWarnings.delete(directory);
      }
    }
    loaded.add(path);
    directoryWarnings.set(path, listing.warnings);
    setWarnings([...directoryWarnings.values()].flat());
    setDirectoryErrors((errors) => {
      const next = { ...errors };
      delete next[path];
      for (const directory of Object.keys(next)) {
        if (isRemoved(directory)) delete next[directory];
      }
      return next;
    });
    setEntries([...next.values()]);
    if (path === "") setLoading(false);
  }
  async function loadDirectory(path: string, force = false): Promise<void> {
    if (disposed || (!force && loaded.has(path))) return;
    const existing = inFlight.get(path);
    if (existing) {
      if (force) refreshAgain.add(path);
      return existing;
    }
    setLoadingDirectories((paths) => [...paths, path]);
    const revision = (directoryRevisions.get(path) ?? 0) + 1;
    directoryRevisions.set(path, revision);
    const request = (async () => {
      try {
        const listing = await listDirectory(threadId, path);
        if (
          disposed ||
          directoryRevisions.get(path) !== revision ||
          (path &&
            !entries().some((entry) => entry.path === path && entry.directory))
        )
          return;
        applyDirectory(path, listing);
      } catch (cause) {
        if (disposed) return;
        const message = String(cause);
        setDirectoryErrors((errors) => ({ ...errors, [path]: message }));
        if (path === "") {
          setError(cause);
          setLoading(false);
        }
      } finally {
        setLoadingDirectories((paths) => paths.filter((item) => item !== path));
      }
    })();
    inFlight.set(path, request);
    await request;
    inFlight.delete(path);
    if (refreshAgain.delete(path) && !disposed) await loadDirectory(path, true);
  }
  async function reveal(path: string) {
    const segments = parentOf(path).split("/").filter(Boolean);
    let parent = "";
    await loadDirectory(parent);
    for (const segment of segments) {
      parent = [parent, segment].filter(Boolean).join("/");
      await loadDirectory(parent);
    }
  }
  async function search(query: string) {
    currentQuery = query;
    const revision = ++searchRevision;
    if (searchTimer) clearTimeout(searchTimer);
    if (!query.trim()) {
      setSearchResults([]);
      setSearching(false);
      if (searchId) void closeSearch(searchId).catch(() => undefined);
      searchId = undefined;
      return;
    }
    searchId ??= crypto.randomUUID();
    const id = searchId;
    setSearching(true);
    searchTimer = setTimeout(() => {
      void searchPaths(threadId, id, query)
        .then((results) => {
          if (!disposed && revision === searchRevision)
            setSearchResults(results);
        })
        .catch((cause) => {
          if (!disposed && revision === searchRevision) setError(cause);
        })
        .finally(() => {
          if (!disposed && revision === searchRevision) setSearching(false);
        });
    }, 200);
  }

  async function refreshDraft(draft: Draft) {
    const request = (reads.get(draft.id) ?? 0) + 1;
    reads.set(draft.id, request);
    const path = draft.path;
    try {
      const disk = await readFile(threadId, path);
      if (
        disposed ||
        reads.get(draft.id) !== request ||
        !drafts[draft.id] ||
        drafts[draft.id].path !== path
      )
        return;
      if (drafts[draft.id].saving) return;
      if (disk.version === draft.disk.version) {
        setDrafts(draft.id, { problem: undefined, external: undefined });
      } else if (dirty(drafts[draft.id])) {
        setDrafts(draft.id, { external: disk, problem: "conflict" });
      } else {
        setDrafts(draft.id, {
          disk,
          text: disk.text,
          external: undefined,
          problem: undefined,
          revision: draft.revision + 1,
        });
      }
    } catch (cause) {
      if (
        !disposed &&
        reads.get(draft.id) === request &&
        drafts[draft.id]?.path === path
      ) {
        setDrafts(
          draft.id,
          "problem",
          typeof cause === "string" ? cause : "unavailable",
        );
      }
    }
  }
  async function open(path: string) {
    setSelected(path);
    setError(undefined);
    setOpenError(undefined);
    if (imageMime(path)) {
      setImageRevision((revision) => revision + 1);
      return;
    }
    const existing = draftAt(path);
    if (existing) {
      await refreshDraft(existing);
      return;
    }
    const request = (reads.get(path) ?? 0) + 1;
    reads.set(path, request);
    try {
      const disk = await readFile(threadId, path);
      if (disposed || reads.get(path) !== request || draftAt(path)) return;
      const id = crypto.randomUUID();
      setDrafts(id, {
        id,
        path,
        disk,
        text: disk.text,
        saving: false,
        revision: 0,
      });
    } catch (cause) {
      if (!disposed && selected() === path) setOpenError(cause);
    }
  }
  async function save(id: string) {
    const draft = drafts[id];
    if (!draft) return false;
    if (!dirty(draft)) return true;
    if (busy() || draft.saving || draft.disk.readOnly || draft.problem)
      return false;
    const text = draft.text;
    const path = draft.path;
    setError(undefined);
    setDrafts(id, "saving", true);
    try {
      const disk = await saveFile(threadId, path, draft.disk.version, text);
      if (disposed || !drafts[id]) return false;
      // Keep characters typed after this request was submitted.
      const unchanged = drafts[id].text === text;
      setDrafts(id, {
        disk,
        ...(unchanged ? { text: disk.text } : {}),
        problem: undefined,
        external: undefined,
      });
      return true;
    } catch (cause) {
      setError(cause);
      await refreshDraftAfterSave(id);
      return false;
    } finally {
      if (!disposed && drafts[id]) setDrafts(id, "saving", false);
    }
  }
  async function refreshDraftAfterSave(id: string) {
    setDrafts(id, "saving", false);
    await refreshDraft(drafts[id]);
  }
  async function saveAll() {
    if (busy() || Object.values(drafts).some((draft) => draft.saving))
      return false;
    for (const draft of pending()) if (!(await save(draft.id))) return false;
    return pending().length === 0;
  }
  async function update(update: FileUpdate) {
    if (disposed) return;
    if (busy()) {
      deferredUpdates.push(update);
      return;
    }
    if (update.type === "error") {
      setError(update.message);
      setLoading(false);
      return;
    }
    if (update.type === "snapshot") {
      directoryRevisions.set("", (directoryRevisions.get("") ?? 0) + 1);
      applyDirectory("", update);
      if (selected() && imageMime(selected() as string))
        setImageRevision((revision) => revision + 1);
      await Promise.all(
        [...new Set([...loaded, ...Object.keys(directoryErrors())])]
          .filter(Boolean)
          .map((path) => loadDirectory(path, true)),
      );
      await Promise.all(Object.values(drafts).map(refreshDraft));
      return;
    }
    const changed = update.paths;
    const folders = new Set<string>();
    for (const path of changed) {
      if (path === "") {
        for (const directory of loaded) folders.add(directory);
      } else {
        const parent = parentOf(path);
        if (loaded.has(parent)) folders.add(parent);
        if (loaded.has(path)) folders.add(path);
      }
    }
    await Promise.all([...folders].map((path) => loadDirectory(path, true)));
    const selectedPath = selected();
    if (
      selectedPath &&
      imageMime(selectedPath) &&
      changed.some(
        (path) => within(selectedPath, path) || within(path, selectedPath),
      )
    ) {
      setImageRevision((revision) => revision + 1);
    }
    await Promise.all(
      Object.values(drafts)
        .filter((draft) =>
          changed.some(
            (path) => within(draft.path, path) || within(path, draft.path),
          ),
        )
        .map(refreshDraft),
    );
    if (currentQuery) void search(currentQuery);
  }
  async function operation(action: Parameters<typeof operateFile>[1]) {
    if (busy() || Object.values(drafts).some((draft) => draft.saving))
      return false;
    setBusy(true);
    setError(undefined);
    try {
      await operateFile(threadId, action);
      reads.clear();
      if (disposed) return false;
      if (action.type === "move") {
        for (const directory of [...loaded]) {
          if (within(directory, action.from)) {
            loaded.delete(directory);
            loaded.add(action.to + directory.slice(action.from.length));
          }
        }
        for (const [directory, warnings] of [...directoryWarnings]) {
          if (within(directory, action.from)) {
            directoryWarnings.delete(directory);
            directoryWarnings.set(
              action.to + directory.slice(action.from.length),
              warnings,
            );
          }
        }
        for (const draft of Object.values(drafts)) {
          if (within(draft.path, action.from))
            setDrafts(
              draft.id,
              "path",
              action.to + draft.path.slice(action.from.length),
            );
        }
        const path = selected();
        if (path && within(path, action.from))
          await open(action.to + path.slice(action.from.length));
        setEntries(
          entries().map((entry) =>
            within(entry.path, action.from)
              ? {
                  ...entry,
                  path: action.to + entry.path.slice(action.from.length),
                }
              : entry,
          ),
        );
      } else if (action.type === "create") {
        setEntries([
          ...entries(),
          { path: action.path, directory: action.directory, symlink: false },
        ]);
        if (!action.directory) await open(action.path);
      } else {
        for (const directory of [...loaded]) {
          if (within(directory, action.path)) loaded.delete(directory);
        }
        for (const draft of Object.values(drafts))
          if (within(draft.path, action.path))
            setDrafts(
              produce((state) => {
                delete state[draft.id];
              }),
            );
        if (selected() && within(selected() as string, action.path))
          setSelected(undefined);
        setEntries(
          entries().filter((entry) => !within(entry.path, action.path)),
        );
      }
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setBusy(false);
      for (const pendingUpdate of deferredUpdates.splice(0))
        await update(pendingUpdate);
    }
  }
  return {
    threadId,
    entries,
    drafts,
    selected,
    current,
    error,
    setError,
    openError,
    warnings,
    loading,
    busy,
    pending,
    generation,
    imageRevision,
    searchResults,
    searching,
    directoryErrors,
    loadingDirectories,
    loaded: (path: string) => loaded.has(path),
    prefetch: () => loadDirectory(""),
    loadDirectory,
    reveal,
    search,
    open,
    save,
    saveAll,
    update,
    operation,
    change: (id: string, text: string) => setDrafts(id, "text", text),
    discard: () => {
      for (const draft of pending())
        setDrafts(draft.id, {
          text: draft.disk.text,
          revision: draft.revision + 1,
        });
    },
    reload: async (id: string) => {
      const draft = drafts[id];
      try {
        const disk = await readFile(threadId, draft.path);
        if (!disposed && drafts[id])
          setDrafts(id, {
            disk,
            text: disk.text,
            external: undefined,
            problem: undefined,
            revision: draft.revision + 1,
          });
      } catch (cause) {
        setError(cause);
      }
    },
    retry: () => {
      setError(undefined);
      setOpenError(undefined);
      setLoading(true);
      setGeneration((value) => value + 1);
    },
    dispose: () => {
      disposed = true;
      reads.clear();
      if (searchTimer) clearTimeout(searchTimer);
      if (searchId) void closeSearch(searchId).catch(() => undefined);
    },
  };
}
export type FilesModel = ReturnType<typeof createFilesModel>;
