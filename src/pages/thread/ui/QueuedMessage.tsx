import { useI18n } from "shared/i18n";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { QueuedMessage as QueuedMessageData } from "../model/types";

export function QueuedMessage(props: {
  messages: QueuedMessageData[];
  onDelete: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const messages = createMemo(
    () => new Map(props.messages.map((message) => [message.id, message.text])),
  );
  return (
    <Show when={props.messages.length}>
      <ul
        aria-label={t("thread.queue")}
        class="min-h-thread-queue-row max-h-thread-queue mb-2 shrink overflow-y-auto overscroll-contain rounded-xl border border-line bg-panel px-3 py-1"
      >
        <For each={[...messages().keys()]}>
          {(id) => {
            const [deleting, setDeleting] = createSignal(false);
            return (
              <li class="flex h-8 items-center gap-2 text-sm">
                <span class="min-w-0 flex-1 truncate">
                  {messages().get(id)}
                </span>
                <button
                  type="button"
                  aria-label={t("thread.deleteQueued", {
                    message: messages().get(id) ?? "",
                  })}
                  disabled={deleting()}
                  class="shrink-0 rounded p-1 text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
                  onClick={async () => {
                    setDeleting(true);
                    try {
                      await props.onDelete(id);
                    } finally {
                      setDeleting(false);
                    }
                  }}
                >
                  <svg
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
                  </svg>
                </button>
              </li>
            );
          }}
        </For>
      </ul>
    </Show>
  );
}
