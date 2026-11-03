import { FileIcon, fileMentionChipClass } from "shared/ui";
import { For } from "solid-js";
import { mentionFileName } from "../model/file-mentions";
import type { FileMention } from "../model/types";

export function MentionText(props: { text: string; mentions: FileMention[] }) {
  const parts = () => {
    const result: { text: string; path?: string }[] = [];
    let end = 0;
    for (const m of props.mentions.toSorted((a, b) => a.start - b.start)) {
      if (m.start < end || props.text.slice(m.start, m.end) !== `@${m.path}`)
        continue;
      result.push(
        { text: props.text.slice(end, m.start) },
        { text: mentionFileName(m.path), path: m.path },
      );
      end = m.end;
    }
    result.push({ text: props.text.slice(end) });
    return result;
  };
  return (
    <For each={parts()}>
      {(part) =>
        part.path ? (
          <span
            data-file-mention={part.path}
            title={part.path}
            class={fileMentionChipClass}
          >
            <FileIcon path={part.path} size="size-3.5" />
            <span class="min-w-0 truncate">{part.text}</span>
          </span>
        ) : (
          part.text
        )
      }
    </For>
  );
}
