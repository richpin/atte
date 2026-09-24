import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  FileSelection,
  PreparedAgent,
  ThreadConfigurationValue,
  ThreadMetadata,
  ThreadUpdate,
  UserInput,
} from "../model/types";

export function listThreads() {
  return invoke<ThreadMetadata[]>("list_threads");
}

export function selectWorkingFolder(agentId: string, dialogTitle: string) {
  return invoke<string | null>("select_working_folder", {
    agentId,
    dialogTitle,
  });
}

export function preparedAgents() {
  return invoke<PreparedAgent[]>("prepared_agents");
}

export function connectThread(id: string) {
  return invoke<void>("connect_thread", { id });
}

export function deleteThread(id: string) {
  return invoke<void>("delete_thread", { id });
}

export function selectFiles(dialogTitle: string) {
  return invoke<FileSelection>("select_files", { dialogTitle });
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

export function createThread(folder: string, agentId: string) {
  return invoke<string>("create_thread", { folder, agentId });
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
