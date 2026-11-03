import { createFileIconElement } from "./file-icon";

export const fileMentionChipClass =
  "file-mention-chip inline-flex max-w-full items-center gap-1 rounded-md bg-command/10 px-1.5 py-0.5 align-middle text-command";

export function createFileMentionChip(path: string, name: string) {
  const chip = document.createElement("span");
  chip.className = fileMentionChipClass;
  chip.dataset.fileMention = path;
  chip.title = path;
  chip.append(createFileIconElement(path, "size-3.5"));
  const label = document.createElement("span");
  label.className = "min-w-0 truncate";
  label.textContent = name;
  chip.append(label);
  return chip;
}
