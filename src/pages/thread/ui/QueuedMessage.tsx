import { Trash } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { QueuedMessage as QueuedMessageData } from "../model/types";
import { AttachmentChip } from "./AttachmentChip";

export function QueuedMessage(props: {
  messages: QueuedMessageData[];
  disabled: boolean;
  onDelete: (id: string) => Promise<void>;
  onRetry: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const messages = createMemo(
    () => new Map(props.messages.map((message) => [message.id, message])),
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
            const [retrying, setRetrying] = createSignal(false);
            const message = () => messages().get(id);
            const accessibleMessage = () =>
              message()?.text ||
              message()
                ?.attachments.map((attachment) => attachment.name)
                .join(", ") ||
              "";
            return (
              <li class="flex h-8 items-center gap-2 text-sm">
                <Show
                  when={message()?.text}
                  fallback={
                    <span class="flex min-w-0 flex-1 gap-1 overflow-hidden">
                      <For each={message()?.attachments}>
                        {(attachment) => (
                          <AttachmentChip
                            name={attachment.name}
                            kind={attachment.kind}
                          />
                        )}
                      </For>
                    </span>
                  }
                >
                  <span class="min-w-0 flex-1 truncate">{message()?.text}</span>
                </Show>
                <Show when={message()?.status === "failed"}>
                  <span class="text-danger">{t("thread.queuedFailed")}</span>
                  <button
                    type="button"
                    aria-label={t("thread.retryQueued", {
                      message: accessibleMessage(),
                    })}
                    disabled={props.disabled || retrying() || deleting()}
                    class="shrink-0 rounded px-2 py-1 text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
                    onClick={async () => {
                      setRetrying(true);
                      try {
                        await props.onRetry(id);
                      } finally {
                        setRetrying(false);
                      }
                    }}
                  >
                    {t("common.retry")}
                  </button>
                </Show>
                <button
                  type="button"
                  aria-label={t("thread.deleteQueued", {
                    message: accessibleMessage(),
                  })}
                  disabled={props.disabled || deleting() || retrying()}
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
                  <Trash aria-hidden="true" class="size-4" />
                </button>
              </li>
            );
          }}
        </For>
      </ul>
    </Show>
  );
}
