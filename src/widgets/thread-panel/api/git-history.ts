import { invoke } from "@tauri-apps/api/core";

export type GitReference = {
  name: string;
  label: string;
  oid: string;
  kind: "local" | "remote" | "tag";
};
export type GitRepository = {
  root: string;
  references: GitReference[];
  head: string | null;
  shallow: boolean;
};
export type GitCommit = {
  oid: string;
  parents: string[];
  author: string;
  timestamp: number;
  subject: string;
};
export type HistoryPage = { commits: GitCommit[]; cursor: string | null };
export type GitHistorySnapshot = {
  repository: GitRepository;
  page: HistoryPage;
};
export type ChangedFile = {
  path: string;
  oldPath: string | null;
  change: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
};
export type CommitDetails = {
  commit: GitCommit;
  body: string;
  base: string | null;
  boundary: boolean;
  files: ChangedFile[];
};
export type FilePatch =
  | { kind: "text"; patch: string }
  | { kind: "binary" | "tooLarge" | "unsupported" | "submodule" };

export const openHistory = (threadId: string, reference: string | null) =>
  invoke<GitHistorySnapshot>("open_git_history", { threadId, reference });
export const readPage = (threadId: string, cursor: string) =>
  invoke<HistoryPage>("read_git_history_page", { threadId, cursor });
export const closeHistory = (threadId: string, cursor: string) =>
  invoke<void>("close_git_history", { threadId, cursor });
export const readCommit = (threadId: string, oid: string) =>
  invoke<CommitDetails>("read_git_commit", { threadId, oid });
export const readCommitFile = (threadId: string, oid: string, index: number) =>
  invoke<FilePatch>("read_git_commit_file", { threadId, oid, index });

export function historyError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "kind" in cause) {
    if (cause.kind === "notRepository") return "notRepository";
    if (cause.kind === "unavailable") return "unavailable";
  }
  return "failed";
}
