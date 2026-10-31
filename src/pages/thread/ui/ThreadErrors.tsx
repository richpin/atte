import { CircleAlert } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Button } from "shared/ui";
import { For, Show } from "solid-js";
import { failureKeys } from "../model/thread";
import type { Thread } from "../model/types";

export function ThreadErrors(props: {
  thread: Thread | undefined;
  subscriptionFailed: boolean;
  canReconnect: boolean;
  onReconnect: () => void;
  onManage: () => void;
}) {
  const { t, content } = useI18n();
  const messages = () => {
    const current = props.thread;
    const result: string[] = [];
    if (props.subscriptionFailed) result.push(t("thread.subscriptionFailed"));
    const failure = current?.failure;
    if (failure) result.push(t(failureKeys[failure]));
    if (current?.status === "failed" && !current.failure)
      result.push(t("thread.error.connect"));
    if (current?.storageError)
      result.push(content(current.storageError) ?? current.storageError);
    return result;
  };
  const needsManagement = () =>
    ["agentRemoved", "executableNotFound"].includes(
      props.thread?.failure ?? "",
    );
  const canRecoverConnection = () =>
    (props.subscriptionFailed && props.canReconnect) ||
    props.thread?.failure ||
    (props.thread?.status === "failed" && !props.thread.failure);

  return (
    <Show when={messages().length}>
      <div
        role="status"
        aria-label={t("thread.errors")}
        class="flex shrink-0 items-start gap-3 border-b border-line bg-danger-soft px-6 py-3 text-sm text-danger"
      >
        <CircleAlert aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
        <div class="min-w-0 flex-1 space-y-1 break-words">
          <For each={messages()}>{(message) => <p>{message}</p>}</For>
          <Show
            when={
              props.thread?.failure &&
              props.thread.failureDetail?.message.trim()
            }
          >
            <p class="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-danger/25 bg-canvas/50 px-3 py-2 text-xs">
              {props.thread?.failureDetail?.message}
            </p>
          </Show>
        </div>
        <Show
          when={needsManagement()}
          fallback={
            <Show when={canRecoverConnection()}>
              <Button
                variant="outline"
                size="sm"
                disabled={!props.canReconnect}
                onClick={props.onReconnect}
              >
                {t("thread.reconnect")}
              </Button>
            </Show>
          }
        >
          <Button variant="outline" size="sm" onClick={props.onManage}>
            {t("thread.openAgentManagement")}
          </Button>
        </Show>
      </div>
    </Show>
  );
}
