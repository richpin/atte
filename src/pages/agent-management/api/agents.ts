import { Channel, invoke } from "@tauri-apps/api/core";
import type { ManagedAgent } from "../model/types";

export function catalog() {
  return invoke<ManagedAgent[]>("agent_catalog");
}

export function refreshCatalog() {
  return invoke<ManagedAgent[]>("refresh_agent_catalog");
}

export function install(id: string) {
  const channel = new Channel<string>();
  return invoke<void>("install_agent", { id, channel });
}

export function uninstall(id: string) {
  return invoke<void>("uninstall_agent", { id });
}
