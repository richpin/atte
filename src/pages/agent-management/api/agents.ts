import { Channel, invoke } from "@tauri-apps/api/core";
import type { Authentication, ManagedAgent } from "../model/types";

export function catalog(refresh = false, force = true) {
  return invoke<ManagedAgent[]>(
    refresh ? "refresh_agent_catalog" : "agent_catalog",
    refresh ? { force } : undefined,
  );
}

export function install(id: string, progress: (message: string) => void) {
  const channel = new Channel<string>();
  channel.onmessage = progress;
  return invoke<void>("install_agent", { id, channel });
}

export function authenticate(id: string, method?: string) {
  return invoke<Authentication>("authenticate_agent", {
    id,
    method: method ?? null,
  });
}
