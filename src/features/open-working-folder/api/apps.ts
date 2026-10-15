import { invoke } from "@tauri-apps/api/core";

export type WorkingFolderApp = {
  id: string;
  name: string;
  icon: string | null;
};

export function listWorkingFolderApps(threadId: string) {
  return invoke<WorkingFolderApp[]>("list_working_folder_apps", { threadId });
}

export function openWorkingFolder(threadId: string, target: string) {
  return invoke<void>("open_working_folder", { threadId, target });
}

export function openWorkingFolderWithAppPicker(
  threadId: string,
  dialogTitle: string,
) {
  return invoke<void>("open_working_folder_with_app_picker", {
    threadId,
    dialogTitle,
  });
}
