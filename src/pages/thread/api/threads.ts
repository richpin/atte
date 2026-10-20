import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  FileSelection,
  MediaKind,
  PreparedAgent,
  ThreadConfigurationValue,
  ThreadMetadata,
  ThreadUpdate,
  UserInput,
} from "../model/types";

export function listThreads() {
  return invoke<ThreadMetadata[]>("list_threads");
}

export function selectWorkingFolder(dialogTitle: string) {
  return invoke<string | null>("select_working_folder", {
    dialogTitle,
  });
}

export function preparedAgents() {
  return invoke<PreparedAgent[]>("prepared_agents");
}

export function connectThread(id: string) {
  return invoke<void>("connect_thread", { id });
}

export function reconnectThread(id: string) {
  return invoke<void>("reconnect_thread", { id });
}

export function deleteThread(id: string) {
  return invoke<void>("delete_thread", { id });
}

export function renameThread(id: string, title: string) {
  return invoke<void>("rename_thread", { id, title });
}

export function selectFiles(id: string, dialogTitle: string) {
  return invoke<FileSelection>("select_files", { id, dialogTitle });
}

export function selectMedia(id: string, kind: MediaKind, dialogTitle: string) {
  return invoke<FileSelection>("select_media", { id, kind, dialogTitle });
}

export function snapshotClipboardImage(
  id: string,
  name: string,
  mimeType: string,
  bytes: number[],
) {
  return invoke<FileSelection>("snapshot_clipboard_image", {
    id,
    name,
    mimeType,
    bytes,
  });
}

export function sendMessage(id: string, input: UserInput) {
  return invoke<void>("send_message", {
    id,
    input: {
      text: input.text,
      attachments: input.attachments.map(({ id }) => id),
    },
  });
}

export function releaseFiles(attachments: string[]) {
  return invoke<void>("release_files", { attachments });
}

export function deleteQueuedMessage(id: string, message: string) {
  return invoke<void>("delete_queued_message", { id, message });
}

export function retryQueuedMessage(id: string, message: string) {
  return invoke<void>("retry_queued_message", { id, message });
}

export type WorkingMode = "local" | "worktree";
export interface WorkingFolderInfo {
  repositoryRoot: string | null;
  commit: string | null;
  unavailableReason: string | null;
}

export function inspectWorkingFolder(folder: string) {
  return invoke<WorkingFolderInfo>("inspect_working_folder", { folder });
}

export function createThread(
  folder: string,
  agentId: string,
  workingMode: WorkingMode,
) {
  return invoke<string>("create_thread", { folder, agentId, workingMode });
}

export function createThreadInExistingWorktree(
  sourceThreadId: string,
  agentId: string,
) {
  return invoke<string>("create_thread_in_existing_worktree", {
    sourceThreadId,
    agentId,
  });
}

export function cancelTurn(id: string, turn: string) {
  return invoke<void>("cancel_turn", { id, turn });
}

export function answerPermission(id: string, request: string, option: string) {
  return invoke<void>("answer_permission", { id, request, option });
}

export function setThreadConfiguration(
  id: string,
  configId: string,
  value: ThreadConfigurationValue,
) {
  return invoke<void>("set_thread_configuration", { id, configId, value });
}

export function subscribeThread(
  id: string,
  receive: (update: ThreadUpdate) => void,
  failed: (cause: unknown) => void,
): () => void {
  return subscribe("subscribe_thread", { id }, receive, failed);
}

export function subscribeThreadList(
  receive: (entries: ThreadMetadata[]) => void,
  failed: (cause: unknown) => void,
): () => void {
  return subscribe("subscribe_thread_list", {}, receive, failed);
}

function subscribe<T>(
  command: string,
  args: Record<string, string>,
  receive: (update: T) => void,
  failed: (cause: unknown) => void,
): () => void {
  const channel = new Channel<T>();
  let disposed = false;
  let subscription: string | undefined;
  channel.onmessage = (update) => {
    if (!disposed) receive(update);
  };
  const unsubscribe = (subscription: string) => {
    void invoke("unsubscribe_thread", { subscription }).catch((cause) => {
      if (!disposed) failed(cause);
    });
  };
  void invoke<string>(command, { ...args, channel })
    .then((token) => {
      if (disposed) unsubscribe(token);
      else subscription = token;
    })
    .catch((cause) => {
      if (!disposed) failed(cause);
    });
  return () => {
    disposed = true;
    if (subscription) unsubscribe(subscription);
  };
}
