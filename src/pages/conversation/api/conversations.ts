import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Conversation,
  ConversationSummary,
  ConversationUpdate,
  PreparedAgent,
} from "../model/types";

export function listConversations() {
  return invoke<ConversationSummary[]>("list_conversations");
}

export function selectWorkingFolder(agentId: string) {
  return invoke<Conversation | null>("select_working_folder", { agentId });
}

export function preparedAgents() {
  return invoke<PreparedAgent[]>("prepared_agents");
}

export function connectConversation(id: string) {
  return invoke<Conversation>("connect_conversation", { id });
}

export function getConversation(id: string) {
  return invoke<Conversation>("get_conversation", { id });
}

export function sendMessage(id: string, text: string) {
  return invoke<Conversation>("send_message", { id, text });
}

export function deleteQueuedMessage(id: string, message: string) {
  return invoke<Conversation>("delete_queued_message", { id, message });
}

export function createConversation(folder: string, agentId: string) {
  return invoke<Conversation>("create_conversation", { folder, agentId });
}

export function cancelTurn(id: string, turn: string) {
  return invoke<Conversation>("cancel_turn", { id, turn });
}

export function answerPermission(id: string, request: string, option: string) {
  return invoke<Conversation>("answer_permission", { id, request, option });
}

export function subscribeConversation(
  id: string,
  receive: (update: ConversationUpdate) => void,
  failed: () => void,
): () => void {
  return subscribe("subscribe_conversation", { id }, receive, failed);
}

export function subscribeConversationList(
  receive: (entries: ConversationSummary[]) => void,
  failed: () => void,
): () => void {
  return subscribe("subscribe_conversation_list", {}, receive, failed);
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
  channel.onmessage = (snapshot) => {
    if (!disposed) receive(snapshot);
  };
  const unsubscribe = (subscription: string) => {
    void invoke("unsubscribe_conversation", { subscription }).catch(() => {
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
