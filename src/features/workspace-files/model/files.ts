import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  type DiskFile,
  type FileEntry,
  type FileUpdate,
  operateFile,
  readFile,
  saveFile,
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
  const [warnings, setWarnings] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [generation, setGeneration] = createSignal(0);
  const [imageRevision, setImageRevision] = createSignal(0);
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
      if (!disposed && selected() === path) setError(cause);
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
    setWarnings(update.warnings);
    const path = selected();
    if (
      path &&
      imageMime(path) &&
      (update.type === "snapshot" ||
        [...update.changed, ...update.removed].some((changed) =>
          within(path, changed),
        ))
    )
      setImageRevision((revision) => revision + 1);
    if (update.type === "snapshot") {
      setEntries(update.entries);
      setLoading(false);
      await Promise.all(Object.values(drafts).map(refreshDraft));
    } else {
      if (update.removed.length || update.entries.length) {
        const removed = new Set(update.removed);
        const map = new Map(
          entries()
            .filter((entry) => !removed.has(entry.path))
            .map((entry) => [entry.path, entry]),
        );
        for (const entry of update.entries) map.set(entry.path, entry);
        setEntries([...map.values()]);
      }
      await Promise.all(
        Object.values(drafts)
          .filter((draft) =>
            [...update.changed, ...update.removed].some((path) =>
              within(draft.path, path),
            ),
          )
          .map(refreshDraft),
      );
    }
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
    warnings,
    loading,
    busy,
    pending,
    generation,
    imageRevision,
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
      setLoading(true);
      setGeneration((value) => value + 1);
    },
    dispose: () => {
      disposed = true;
      reads.clear();
    },
  };
}
export type FilesModel = ReturnType<typeof createFilesModel>;
