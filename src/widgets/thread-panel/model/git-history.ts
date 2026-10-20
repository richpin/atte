import { createSignal, onCleanup } from "solid-js";
import {
  closeHistory,
  type GitRepository,
  openHistory,
  readPage,
} from "../api/git-history";
import { createGraphLayout, type GraphRow } from "../lib/git-graph";

export function createHistoryModel(threadId: string) {
  const [repository, setRepository] = createSignal<GitRepository>();
  const [rows, setRows] = createSignal<GraphRow[]>([]);
  const [reference, setReference] = createSignal<string | null>(null);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<unknown>();
  const [revision, setRevision] = createSignal(0);
  let graph = createGraphLayout();
  let generation = 0;
  let disposed = false;
  const release = (cursor: string | null) => {
    if (cursor) void closeHistory(threadId, cursor).catch(() => {});
  };
  async function refresh(nextReference = reference()) {
    const request = ++generation;
    release(cursor());
    setCursor(null);
    setReference(nextReference);
    setLoading(true);
    setError(undefined);
    setRows([]);
    graph = createGraphLayout();
    setRevision((value) => value + 1);
    try {
      const snapshot = await openHistory(threadId, nextReference);
      if (disposed || request !== generation) {
        release(snapshot.page.cursor);
        return;
      }
      setRepository(snapshot.repository);
      setRows(graph.append(snapshot.page.commits));
      setCursor(snapshot.page.cursor);
    } catch (cause) {
      if (!disposed && request === generation) setError(cause);
    } finally {
      if (!disposed && request === generation) setLoading(false);
    }
  }
  async function loadMore() {
    const next = cursor();
    if (!next || loading() || error() || disposed) return;
    const request = generation;
    setLoading(true);
    try {
      const page = await readPage(threadId, next);
      if (disposed || request !== generation) return;
      const added = graph.append(page.commits);
      setRows((rows) => [...rows, ...added]);
      setCursor(page.cursor);
    } catch (cause) {
      if (!disposed && request === generation) {
        // A failed stream cannot be replayed safely. Refresh restarts its snapshot.
        release(next);
        setCursor(null);
        setError(cause);
      }
    } finally {
      if (!disposed && request === generation) setLoading(false);
    }
  }
  onCleanup(() => {
    disposed = true;
    generation++;
    release(cursor());
  });
  return {
    repository,
    rows,
    reference,
    cursor,
    loading,
    error,
    revision,
    refresh,
    loadMore,
  };
}
