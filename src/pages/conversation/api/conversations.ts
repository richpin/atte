import { invoke } from "@tauri-apps/api/core";
import type { Conversation } from "../model/types";

export function selectWorkingFolder() {
  return invoke<Conversation | null>("select_working_folder");
}
