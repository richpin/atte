import { createStore } from "solid-js/store";
import type { WorkingSide } from "../api/git-working";

export type WorkingSelection = { id: string; side: WorkingSide };
const [drafts, setDrafts] = createStore<
  Record<string, { title: string; body: string }>
>({});
export const draftFor = (root: string) =>
  drafts[root] ?? { title: "", body: "" };
export const setDraft = (root: string, key: "title" | "body", value: string) =>
  setDrafts(root, { ...draftFor(root), [key]: value });
export const clearDraft = (root: string) =>
  setDrafts(root, { title: "", body: "" });

const [selections, setSelections] = createStore<
  Record<string, WorkingSelection>
>({});
export const selectionFor = (threadId: string) => selections[threadId];
export const selectWorkingFile = (
  threadId: string,
  selection: WorkingSelection,
) => setSelections(threadId, selection);

const [roots, setRoots] = createStore<Record<string, string>>({});
export const rootForThread = (threadId: string) => roots[threadId];
export const rememberRoot = (threadId: string, root: string) =>
  setRoots(threadId, root);
const [busy, setBusy] = createStore<Record<string, boolean>>({});
export const workingBusy = (root: string) => Boolean(busy[root]);
export const setWorkingBusy = (root: string, value: boolean) =>
  setBusy(root, value);
export const workingQueryKey = (root: string) => ["git-working", root] as const;
