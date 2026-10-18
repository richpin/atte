import { Channel, invoke } from "@tauri-apps/api/core";

export type FileEntry = { path: string; directory: boolean; symlink: boolean };
export type DiskFile = { text: string; version: string; readOnly: boolean };
export type FileUpdate =
  | { type: "snapshot"; entries: FileEntry[]; warnings: string[] }
  | {
      type: "changed";
      entries: FileEntry[];
      removed: string[];
      changed: string[];
      warnings: string[];
    }
  | { type: "error"; message: string };
export type FileOperation =
  | { type: "create"; path: string; directory: boolean }
  | { type: "move"; from: string; to: string }
  | { type: "trash"; path: string };
export const readFile = (threadId: string, path: string) =>
  invoke<DiskFile>("read_workspace_file", { threadId, path });
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
