import { invoke } from "@tauri-apps/api/core";

export function selectWorkingFolder(dialogTitle: string) {
  return invoke<string | null>("select_working_folder", { dialogTitle });
}
