import { Channel, invoke } from "@tauri-apps/api/core";

export type FileEntry = { path: string; directory: boolean; symlink: boolean };
export type DirectoryListing = { entries: FileEntry[]; warnings: string[] };
export type DiskFile = { text: string; version: string; readOnly: boolean };
export type FileUpdate =
  | { type: "snapshot"; entries: FileEntry[]; warnings: string[] }
  | {
      type: "changed";
      paths: string[];
    }
  | { type: "error"; message: string };
export type FileOperation =
  | { type: "create"; path: string; directory: boolean }
  | { type: "move"; from: string; to: string }
  | { type: "trash"; path: string };
export const readFile = (threadId: string, path: string) =>
  invoke<DiskFile>("read_workspace_file", { threadId, path });
export const resolveExistingFile = (threadId: string, path: string) =>
  invoke<string>("resolve_existing_workspace_file", { threadId, path });
export const listDirectory = (threadId: string, path: string) =>
  invoke<DirectoryListing>("list_workspace_directory", { threadId, path });
export const searchPaths = (
  threadId: string,
  searchId: string,
  query: string,
) =>
  invoke<FileEntry[]>("search_workspace_paths", { threadId, searchId, query });
export const closeSearch = (searchId: string) =>
  invoke<void>("close_workspace_search", { searchId });
export const readImage = (threadId: string, path: string) =>
  invoke<ArrayBuffer>("read_workspace_image", { threadId, path });
export const saveFile = (
  threadId: string,
  path: string,
  version: string,
  text: string,
) => invoke<DiskFile>("save_workspace_file", { threadId, path, version, text });
export const operateFile = (threadId: string, operation: FileOperation) =>
  invoke<void>("operate_workspace_file", { threadId, operation });
export async function subscribeFiles(
  threadId: string,
  receive: (update: FileUpdate) => void,
) {
  const subscriptionId = crypto.randomUUID();
  const channel = new Channel<FileUpdate>();
  channel.onmessage = receive;
  await invoke("subscribe_workspace_files", {
    threadId,
    subscriptionId,
    channel,
  });
  return () => invoke<void>("unsubscribe_workspace_files", { subscriptionId });
}
