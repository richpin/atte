import type { AgentAuthenticationState } from "features/agent-authentication";
import { useI18n } from "shared/i18n";
import { For, Match, Show, Switch } from "solid-js";
import type { Thread } from "../model/types";
import { PermissionInput } from "./PermissionInput";
import { PromptInput } from "./PromptInput";
import { QueuedMessage } from "./QueuedMessage";

export function ThreadComposer(props: {
  active: boolean;
  thread: Thread;
  agentName: string;
  draft: string;
  answerPending: boolean;
  cancelPending: boolean;
  showStop: boolean;
  stopping: boolean;
  actionsEnabled: boolean;
  canSend: boolean;
  authentication?: AgentAuthenticationState;
  onDraftChange: (message: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onAnswer: (request: string, option: string) => void;
  onDeleteQueued: (id: string) => Promise<void>;
  onRetryAuthentication?: () => void;
  onAuthenticate?: (method: string) => void;
  onCancelAuthentication?: () => void;
}) {
  const { t } = useI18n();
  const authentication = (): AgentAuthenticationState =>
    props.authentication ?? { status: "idle" };
  const authenticationState = <
    Status extends AgentAuthenticationState["status"],
  >(
    status: Status,
  ) => {
    const current = authentication();
    return current.status === status
      ? (current as Extract<AgentAuthenticationState, { status: Status }>)
      : undefined;
  };

  return (
    <div class="max-h-thread-composer mx-auto flex w-full max-w-4xl flex-col overflow-hidden px-6">
      <QueuedMessage
        messages={props.thread.queuedMessages ?? []}
        disabled={!props.actionsEnabled}
        onDelete={props.onDeleteQueued}
      />
      <Show
        when={props.thread.failure === "authenticationRequired"}
        fallback={
          <form
            class="max-h-thread-composer-form shrink-0 overflow-y-auto overscroll-contain rounded-2xl border border-line bg-panel p-4"
            onSubmit={(event) => {
              event.preventDefault();
              props.onSend();
            }}
          >
            <Show
              when={props.thread.permissions?.[0]}
              fallback={
                <PromptInput
                  value={props.draft}
                  disabled={!props.canSend}
                  focusKey={
                    props.active && props.thread.status === "sessionReady"
                      ? props.thread.id
                      : undefined
                  }
                  onInput={props.onDraftChange}
                  onSubmit={props.onSend}
                />
              }
            >
              {(request) => (
                <PermissionInput
                  request={request()}
                  workingFolder={props.thread.workingFolder}
                  disabled={
                    !props.actionsEnabled ||
                    props.answerPending ||
                    props.cancelPending
                  }
                  onAnswer={props.onAnswer}
                />
              )}
            </Show>
            <div class="mt-3 flex items-center justify-between text-xs text-muted">
              <span>{props.agentName}</span>
              <button
                type={props.showStop ? "button" : "submit"}
                aria-label={
                  props.showStop ? t("thread.stop") : t("thread.send")
                }
                class="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
                disabled={
                  props.showStop
                    ? !props.actionsEnabled || props.stopping
                    : !props.canSend || !props.draft.trim()
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
        }
      >
        <section class="shrink-0 rounded-2xl border border-line bg-panel p-4">
          <Switch>
            <Match when={authenticationState("loading")}>
              <p role="status">{t("thread.authentication.loading")}</p>
            </Match>
            <Match when={authenticationState("error")}>
              {(state) => (
                <>
                  <p role="alert">{state().message}</p>
                  <button
                    type="button"
                    class="mt-3 rounded-lg bg-accent px-4 py-2 text-sm text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                    onClick={() => props.onRetryAuthentication?.()}
                  >
                    {t("common.retry")}
                  </button>
                </>
              )}
            </Match>
            <Match when={authenticationState("ready")}>
              {(state) => (
                <div class="space-y-3">
                  <For each={state().methods}>
                    {(method) => (
                      <div>
                        <button
                          type="button"
                          class="w-full rounded-lg bg-accent px-4 py-2 text-sm text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                          onClick={() => props.onAuthenticate?.(method.id)}
                        >
                          {method.name}
                        </button>
                        <Show when={method.description}>
                          {(description) => (
                            <p class="mt-1 text-xs text-muted">
                              {description()}
                            </p>
                          )}
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </Match>
            <Match when={authenticationState("authenticating")}>
              {(state) => (
                <div class="flex items-center justify-between gap-4">
                  <p role="status">
                    {t("thread.authentication.inProgress", {
                      method: state().method.name,
                    })}
                  </p>
                  <button
                    type="button"
                    class="rounded-lg border border-line px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                    onClick={() => props.onCancelAuthentication?.()}
                  >
                    {t("thread.authentication.cancel")}
                  </button>
                </div>
              )}
            </Match>
          </Switch>
        </section>
      </Show>
      <Show when={props.thread.failure !== "authenticationRequired"}>
        <p
          id="connection-note"
          class="mt-2 shrink-0 text-center text-xs text-muted"
        >
          {props.thread.status === "running"
            ? t("thread.composer.running")
            : t("thread.composer.ready")}
        </p>
      </Show>
    </div>
  );
}
