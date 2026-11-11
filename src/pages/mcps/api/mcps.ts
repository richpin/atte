import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  CheckResult,
  ImportFormat,
  ImportSelection,
  ImportSource,
  Server,
  Snapshot,
  Target,
} from "../model/types";

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

export function discoverMcps() {
  return invoke<ImportSource[]>("discover_mcps");
}
export function previewMcpImport(text: string, format: ImportFormat) {
  return invoke<ImportSource>("preview_mcp_import", {
    text,
    format,
  });
}
export function selectMcpImport(format: ImportFormat) {
  return invoke<ImportSource | null>("select_mcp_import", { format });
}
export function importMcps(target: Target, selections: ImportSelection[]) {
  return invoke<{ id: string; name: string; error: string | null }[]>(
    "import_mcps",
    {
      target,
      selections,
    },
  );
}
export function clearMcpImports() {
  return invoke<void>("clear_mcp_imports");
}
export function checkMcp(target: Target, name: string, id: string) {
  return invoke<CheckResult>("check_mcp", {
    target,
    name,
    id,
  });
}
export function cancelMcpCheck(id: string) {
  return invoke<void>("cancel_mcp_check", { id });
}
