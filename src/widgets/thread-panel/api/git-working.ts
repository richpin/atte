import { invoke } from "@tauri-apps/api/core";
import type { FilePatch } from "./git-history";

export type WorkingFile = {
  id: string;
  path: string;
  oldPath: string | null;
  oldId: string | null;
  status: string;
  staged: boolean;
  unstaged: boolean;
  conflict: boolean;
  submodule: boolean;
  exists: boolean;
  stagedChange: WorkingSideChange | null;
  unstagedChange: WorkingSideChange | null;
};
export type WorkingSideChange = {
  oldPath: string | null;
  additions: number | null;
  deletions: number | null;
  revision: string;
};
export type WorkingSnapshot = {
  root: string;
  branch: string | null;
  head: string | null;
  indexTree: string | null;
  operation: string | null;
  files: WorkingFile[];
  revision: string;
  latestStash: string | null;
};
export type WorkingSide = "staged" | "unstaged";
export const readWorkingChanges = (threadId: string) =>
  invoke<WorkingSnapshot>("read_git_working_changes", { threadId });
export const readWorkingFile = (
  threadId: string,
  fileId: string,
  side: WorkingSide,
) => invoke<FilePatch>("read_git_working_file", { threadId, fileId, side });
export const stageFiles = (threadId: string, fileIds: string[], all = false) =>
  invoke<WorkingSnapshot>("stage_git_files", { threadId, fileIds, all });
export const unstageFiles = (
  threadId: string,
  fileIds: string[],
  all = false,
) => invoke<WorkingSnapshot>("unstage_git_files", { threadId, fileIds, all });
export const restoreFiles = (
  threadId: string,
  fileIds: string[],
  all: boolean,
  expectedRevision: string,
) =>
  invoke<WorkingSnapshot>("restore_git_files", {
    threadId,
    fileIds,
    all,
    expectedRevision,
  });
export const trashFiles = (
  threadId: string,
  fileIds: string[],
  expectedRevision: string,
) =>
  invoke<WorkingSnapshot>("trash_git_files", {
    threadId,
    fileIds,
    expectedRevision,
  });
export const stashAll = (threadId: string, expectedRevision: string) =>
  invoke<WorkingSnapshot>("stash_git_all", { threadId, expectedRevision });
export const stashPop = (
  threadId: string,
  expectedRevision: string,
  expectedStash: string | null,
) =>
  invoke<WorkingSnapshot>("stash_git_pop", {
    threadId,
    expectedRevision,
    expectedStash,
  });
export const commitChanges = (
  threadId: string,
  message: string,
  expectedHead: string | null,
  expectedIndexTree: string,
) =>
  invoke<WorkingSnapshot>("commit_git_changes", {
    threadId,
    message,
    expectedHead,
    expectedIndexTree,
  });

export function workingError(
  cause: unknown,
): "notRepository" | "unavailable" | "failed" {
  if (typeof cause === "object" && cause !== null && "kind" in cause) {
    if (cause.kind === "notRepository") return "notRepository";
    if (cause.kind === "unavailable") return "unavailable";
  }
  return "failed";
}
