import { Channel, invoke } from "@tauri-apps/api/core";
import type { Server, Snapshot, Target } from "../model/types";

export async function subscribeMcp(
  target: Target,
  receive: (snapshot: Snapshot) => void,
) {
  const channel = new Channel<Snapshot>();
  channel.onmessage = receive;
  const subscription = await invoke<string>("subscribe_mcp", {
    target,
    channel,
  });
  return () => {
    void invoke("unsubscribe_thread", { subscription }).catch(() => {});
  };
}
export function saveMcp(
  target: Target,
  name: string,
  server: Server,
  secrets: Record<string, string>,
  create: boolean,
) {
  return invoke<void>("save_mcp", { target, name, server, secrets, create });
}
export function removeMcp(target: Target, name: string) {
  return invoke<void>("remove_mcp", { target, name });
}

export function toggleMcp(target: Target, name: string, enabled: boolean) {
  return invoke<void>("toggle_mcp", { target, name, enabled });
}
