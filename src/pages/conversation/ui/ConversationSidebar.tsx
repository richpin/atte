import { createMemo, createSignal, For, Show } from "solid-js";
import type { ConversationMetadata } from "../model/types";

export function ConversationSidebar(props: {
  conversations: ConversationMetadata[];
  selected?: string;
  loading: boolean;
  failed: boolean;
  creating: boolean;
  onRetry: () => void;
  onSelect: (id: string) => void;
  onCreate: (folder: string) => void;
  onClose: () => void;
}) {
  const [collapsed, setCollapsed] = createSignal(new Set<string>());
  const groups = createMemo(() => {
    const folders = new Map<string, ConversationMetadata[]>();
    for (const conversation of props.conversations) {
      const entries = folders.get(conversation.workingFolder) ?? [];
      entries.push(conversation);
      folders.set(conversation.workingFolder, entries);
    }
    return [...folders.keys()].sort().map((folder) => ({
      folder,
      name: folder.split("/").filter(Boolean).at(-1) ?? folder,
      entries: folders.get(folder) ?? [],
    }));
  });
  return (
    <nav
      aria-label="대화 목록"
      class="flex w-60 shrink-0 flex-col border-r border-line bg-panel"
    >
      <div class="flex items-center justify-between p-3">
        <h2 class="text-xs font-medium text-muted">프로젝트</h2>
        <button
          type="button"
          aria-label="사이드바 닫기"
          class="rounded p-1 text-muted hover:bg-canvas"
          onClick={props.onClose}
        >
          ◧
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <Show when={props.failed}>
          <p role="alert" class="text-sm">
            대화 목록을 불러올 수 없습니다.
          </p>
          <button type="button" onClick={props.onRetry}>
            목록 다시 불러오기
          </button>
        </Show>
        <Show
          when={!props.loading && !props.conversations.length && !props.failed}
        >
          <p class="px-2 text-sm text-muted">저장된 대화가 없습니다.</p>
        </Show>
        <For each={groups()}>
          {(group) => (
            <section class="mb-3">
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`프로젝트 ${group.name}`}
                  aria-expanded={!collapsed().has(group.folder)}
                  class="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-canvas"
                  onClick={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(group.folder)) next.delete(group.folder);
                      else next.add(group.folder);
                      return next;
                    })
                  }
                >
                  <span aria-hidden="true">
                    {collapsed().has(group.folder) ? "▸" : "▾"}
                  </span>
                  <span class="truncate">{group.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`${group.name}에 새 대화`}
                  disabled={props.creating}
                  class="shrink-0 rounded px-2 py-1 text-muted hover:bg-canvas disabled:opacity-40"
                  onClick={() => props.onCreate(group.folder)}
                >
                  +
                </button>
              </div>
              <Show when={!collapsed().has(group.folder)}>
                <For each={group.entries}>
                  {(entry) => (
                    <button
                      type="button"
                      aria-current={
                        props.selected === entry.id ? "page" : undefined
                      }
                      class="mb-1 flex w-full items-center gap-2 rounded-lg py-2 pr-2 pl-7 text-left text-sm hover:bg-canvas aria-[current=page]:bg-canvas"
                      onClick={() => props.onSelect(entry.id)}
                    >
                      <span class="min-w-0 flex-1 truncate">
                        {entry.title || "새 대화"}
                      </span>
                      <Show
                        when={
                          entry.status === "running" ||
                          entry.status === "cancelling"
                        }
                      >
                        <span class="shrink-0 text-xs text-muted">실행 중</span>
                      </Show>
                      <Show when={entry.status === "waitingForApproval"}>
                        <span class="shrink-0 text-xs text-accent">
                          승인 대기
                        </span>
                      </Show>
                      <Show when={entry.status === "failed"}>
                        <span class="shrink-0 text-xs text-muted">
                          연결 오류
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </Show>
            </section>
          )}
        </For>
      </div>
    </nav>
  );
}
