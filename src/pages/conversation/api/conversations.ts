import { invoke } from "@tauri-apps/api/core";
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
