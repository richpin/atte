import { useI18n } from "shared/i18n";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { QueuedMessage } from "../model/types";

export function QueuedMessages(props: {
  messages: QueuedMessage[];
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
        class="mb-2 max-h-40 overflow-y-auto rounded-xl border border-line bg-panel px-3 py-1"
      >
        <For each={[...messages().keys()]}>
          {(id) => {
            const [expanded, setExpanded] = createSignal(false);
            const [deleting, setDeleting] = createSignal(false);
            return (
              <li class="flex items-start gap-2 py-1.5 text-sm">
                <button
                  type="button"
                  aria-expanded={expanded()}
                  class={`min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent ${expanded() ? "whitespace-pre-wrap break-words" : "truncate"}`}
                  onClick={() => setExpanded((value) => !value)}
                >
                  {messages().get(id)}
                </button>
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
