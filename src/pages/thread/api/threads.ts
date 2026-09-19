import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  PreparedAgent,
  Thread,
  ThreadMetadata,
  ThreadUpdate,
} from "../model/types";

export function listThreads() {
  return invoke<ThreadMetadata[]>("list_threads");
}

export function selectWorkingFolder(agentId: string) {
  return invoke<Thread | null>("select_working_folder", { agentId });
}

export function preparedAgents() {
  return invoke<PreparedAgent[]>("prepared_agents");
}

export function connectThread(id: string) {
  return invoke<Thread>("connect_thread", { id });
}

export function getThread(id: string) {
  return invoke<Thread>("get_thread", { id });
}

export function deleteThread(id: string) {
  return invoke<void>("delete_thread", { id });
}

export function sendMessage(id: string, text: string) {
  return invoke<Thread>("send_message", { id, text });
}

export function deleteQueuedMessage(id: string, message: string) {
  return invoke<Thread>("delete_queued_message", { id, message });
}

export function createThread(folder: string, agentId: string) {
  return invoke<Thread>("create_thread", { folder, agentId });
}

export function cancelTurn(id: string, turn: string) {
  return invoke<Thread>("cancel_turn", { id, turn });
}

export function answerPermission(id: string, request: string, option: string) {
  return invoke<Thread>("answer_permission", { id, request, option });
}

export function subscribeThread(
  id: string,
  receive: (update: ThreadUpdate) => void,
  failed: () => void,
): () => void {
  return subscribe("subscribe_thread", { id }, receive, failed);
}

export function subscribeThreadList(
  receive: (entries: ThreadMetadata[]) => void,
  failed: () => void,
): () => void {
  return subscribe("subscribe_thread_list", {}, receive, failed);
}

function subscribe<T>(
  command: string,
  args: Record<string, string>,
  receive: (update: T) => void,
  failed: () => void,
): () => void {
  const channel = new Channel<T>();
  let disposed = false;
  let subscription: string | undefined;
  channel.onmessage = (update) => {
    if (!disposed) receive(update);
  };
  const unsubscribe = (subscription: string) => {
    void invoke("unsubscribe_thread", { subscription }).catch(() => {
      if (!disposed) failed();
    });
  };
  void invoke<string>(command, { ...args, channel })
    .then((token) => {
      if (disposed) unsubscribe(token);
      else subscription = token;
    })
    .catch(() => {
      if (!disposed) failed();
    });
  return () => {
    disposed = true;
    if (subscription) unsubscribe(subscription);
  };
}
