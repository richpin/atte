import { Channel, invoke } from "@tauri-apps/api/core";
import type { Conversation, PreparedAgent } from "../model/types";

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

export function subscribeConversation(
  id: string,
  receive: (snapshot: Conversation) => void,
  failed: () => void,
): () => void {
  const channel = new Channel<Conversation>();
  let disposed = false;
  let subscription: string | undefined;
  channel.onmessage = (snapshot) => {
    if (!disposed) receive(snapshot);
  };
  const unsubscribe = (subscription: string) => {
    void invoke("unsubscribe_conversation", { subscription }).catch(failed);
  };
  void invoke<string>("subscribe_conversation", { id, channel })
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
