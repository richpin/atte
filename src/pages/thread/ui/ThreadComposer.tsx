import { useI18n } from "shared/i18n";
import { Show } from "solid-js";
import type { Thread } from "../model/types";
import { PermissionInput } from "./PermissionInput";
import { PromptInput } from "./PromptInput";
import { QueuedMessage } from "./QueuedMessage";

export function ThreadComposer(props: {
  active: boolean;
  thread: Thread;
  agentName: string;
  message: string;
  sending: boolean;
  answering: boolean;
  cancelling: boolean;
  showStop: boolean;
  stopping: boolean;
  canSend: boolean;
  onMessageChange: (message: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onAnswer: (request: string, option: string) => void;
  onDeleteQueued: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();

  return (
    <div class="mx-auto mb-6 w-full max-w-4xl shrink-0 px-6">
      <QueuedMessage
        messages={props.thread.queuedMessages ?? []}
        onDelete={props.onDeleteQueued}
      />
      <form
        class="max-h-[60dvh] overflow-y-auto rounded-2xl border border-line bg-panel p-4"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSend();
        }}
      >
        <Show
          when={props.thread.permissions?.[0]}
          fallback={
            <PromptInput
              value={props.message}
              disabled={
                props.sending ||
                !["sessionReady", "running", "cancelling"].includes(
                  props.thread.status,
                )
              }
              focusKey={
                props.active && props.thread.status === "sessionReady"
                  ? props.thread.id
                  : undefined
              }
              onInput={props.onMessageChange}
              onSubmit={props.onSend}
            />
          }
        >
          {(request) => (
            <PermissionInput
              request={request()}
              workingFolder={props.thread.workingFolder}
              disabled={props.answering || props.cancelling}
              onAnswer={props.onAnswer}
            />
          )}
        </Show>
        <div class="mt-3 flex items-center justify-between text-xs text-muted">
          <span>{props.agentName}</span>
          <button
            type={props.showStop ? "button" : "submit"}
            aria-label={props.showStop ? t("thread.stop") : t("thread.send")}
            class="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
            disabled={
              props.showStop
                ? props.stopping
                : !props.canSend || !props.message.trim()
            }
            onClick={() => {
              if (props.showStop) props.onCancel();
            }}
          >
            <Show
              when={props.showStop}
              fallback={
                <svg
                  aria-hidden="true"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.25"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 19V5m-7 7 7-7 7 7" />
                </svg>
              }
            >
              <span
                aria-hidden="true"
                class="size-3 rounded-[2px] bg-current"
              />
            </Show>
          </button>
        </div>
      </form>
      <p id="connection-note" class="mt-2 text-center text-xs text-muted">
        {props.thread.status === "running"
          ? t("thread.composer.running")
          : t("thread.composer.ready")}
      </p>
    </div>
  );
}
