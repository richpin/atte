import { useI18n } from "shared/i18n";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "shared/ui";
import { For, Match, Show, Switch } from "solid-js";
import type { AgentAuthenticationState } from "../model/authentication";

export function SignInDialog(props: {
  open: boolean;
  agentName: string;
  state: AgentAuthenticationState;
  reconnectFailed: boolean;
  onClose: () => void;
  onClosed: () => void;
  onRetry: () => void;
  onSelect: (method: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const stateFor = <Status extends AgentAuthenticationState["status"]>(
    status: Status,
  ) => {
    const current = props.state;
    return current.status === status
      ? (current as Extract<AgentAuthenticationState, { status: Status }>)
      : undefined;
  };
  const progress = () => {
    const state = props.state;
    return state.status === "authenticating" || state.status === "cancelling"
      ? state
      : undefined;
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        class="w-[calc(100%-2rem)] max-w-[420px] max-h-[calc(100dvh-2rem)] bg-canvas p-6 text-ink"
        closeLabel={t("thread.authentication.close")}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          props.onClosed();
        }}
      >
        <DialogTitle class="pr-6 leading-snug break-words">
          {t("thread.authentication.title", { agent: props.agentName })}
        </DialogTitle>
        <DialogDescription class="text-muted">
          {t("thread.authentication.choose")}
        </DialogDescription>
        <Switch>
          <Match
            when={
              props.state.status === "idle" || props.state.status === "loading"
            }
          >
            <p role="status" class="text-sm text-muted">
              {t("thread.authentication.loading")}
            </p>
          </Match>
          <Match when={stateFor("error")}>
            {(state) => (
              <>
                <p role="alert" class="text-sm break-words">
                  {state().message}
                </p>
                <Button variant="outline" onClick={props.onRetry}>
                  {t("common.retry")}
                </Button>
              </>
            )}
          </Match>
          <Match when={stateFor("ready")}>
            {(state) => (
              <div class="flex flex-col gap-2">
                <Show
                  when={state().methods.length}
                  fallback={
                    <p role="status" class="text-sm text-muted">
                      {t("thread.authentication.empty")}
                    </p>
                  }
                >
                  <For each={state().methods}>
                    {(method) => (
                      <button
                        type="button"
                        onClick={() => props.onSelect(method.id)}
                        class="flex min-h-16 w-full flex-col justify-center gap-1 rounded-xl border border-line px-4 py-3 text-left break-words hover:bg-menu-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        <span class="text-sm font-medium">{method.name}</span>{" "}
                        <Show when={method.description}>
                          <span class="text-xs leading-relaxed text-muted">
                            {method.description}
                          </span>
                        </Show>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            )}
          </Match>
          <Match when={progress()}>
            {(state) => (
              <div class="space-y-3">
                <p role="status" class="text-sm break-words">
                  {t("thread.authentication.inProgress", {
                    method: state().method.name,
                  })}
                </p>
                <p class="text-xs text-muted">
                  {t(
                    state().method.terminal
                      ? "thread.authentication.terminal"
                      : "thread.authentication.browser",
                  )}
                </p>
                <Show
                  when={props.state.status === "cancelling"}
                  fallback={
                    <Button variant="outline" onClick={props.onCancel}>
                      {t("thread.authentication.cancel")}
                    </Button>
                  }
                >
                  <p role="status" class="text-sm text-muted">
                    {t("thread.authentication.cancelling")}
                  </p>
                </Show>
              </div>
            )}
          </Match>
          <Match when={props.state.status === "authenticated"}>
            <p role="status" class="text-sm text-muted">
              {t(
                props.reconnectFailed
                  ? "thread.authentication.reconnectFailed"
                  : "thread.authentication.reconnecting",
              )}
            </p>
          </Match>
        </Switch>
      </DialogContent>
    </Dialog>
  );
}
