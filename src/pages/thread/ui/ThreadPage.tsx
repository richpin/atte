import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { useAgentAuthentication } from "features/agent-authentication";
import { type TranslationKey, useI18n } from "shared/i18n";
import { createEffect, createSignal, Show, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import type { ThreadModel } from "../model/thread";
import type { ConnectionFailure, PreparedAgent } from "../model/types";
import { Message } from "./Message";
import { ThreadComposer } from "./ThreadComposer";
import { ThreadTimeline } from "./ThreadTimeline";

export function ThreadPage(props: {
  active: boolean;
  model: ThreadModel;
  agents: PreparedAgent[];
  onManage: () => void;
}) {
  const { t, content } = useI18n();
  const authentication = useAgentAuthentication();
  const model = props.model;
  const {
    thread,
    selectedThreadId,
    connecting,
    connectFailed,
    draft,
    setDraft,
    answerPending,
    cancelPending,
    activeTurnId,
    streamingTurnId,
    showStop,
    stopping,
    subscriptionError,
    retryExhausted,
    actionsEnabled,
    canSend,
    send,
    deleteQueued,
    answer,
    cancel,
    configure,
    connect,
    retrySubscription,
  } = model;
  const [composerHeight, setComposerHeight] = createSignal(0);
  let composerOverlay: HTMLDivElement | undefined;
  const { observe: observeComposer } = makeResizeObserver((entries) => {
    const entry = entries.find(({ target }) => target === composerOverlay);
    if (entry) setComposerHeight(entry.contentRect.height);
  });
  const composerInset = () => composerHeight() + 32;
  const [authenticationReconnect, setAuthenticationReconnect] = createStore({
    attemptedByThread: {} as Record<string, number | undefined>,
    blockedByThread: {} as Record<string, number | undefined>,
    completedByAgent: {} as Record<string, number | undefined>,
  });
  let previousSelectedThreadId: string | undefined;

  async function authenticateThread(method: string) {
    const origin = thread();
    if (!origin) return;
    const succeeded = await authentication.login(origin.agentId, method);
    if (!succeeded) return;
    const state = authentication.state(origin.agentId);
    if (state.status !== "authenticated") return;
    setAuthenticationReconnect(
      "completedByAgent",
      origin.agentId,
      state.generation,
    );
    const selected = untrack(thread);
    if (
      selected?.agentId === origin.agentId &&
      selected.id !== origin.id &&
      selected.failure === "authenticationRequired"
    ) {
      setAuthenticationReconnect(
        "blockedByThread",
        selected.id,
        state.generation,
      );
    }
  }

  createEffect(() => {
    const selected = selectedThreadId();
    if (
      previousSelectedThreadId &&
      previousSelectedThreadId !== selected &&
      authenticationReconnect.blockedByThread[previousSelectedThreadId] !==
        undefined
    ) {
      setAuthenticationReconnect(
        "blockedByThread",
        previousSelectedThreadId,
        undefined,
      );
    }
    previousSelectedThreadId = selected;
  });

  createEffect(() => {
    const current = thread();
    if (current?.failure !== "authenticationRequired") return;
    const state = authentication.state(current.agentId);
    if (state.status === "authenticated") {
      if (
        authenticationReconnect.completedByAgent[current.agentId] !==
          state.generation ||
        authenticationReconnect.blockedByThread[current.id] === state.generation
      )
        return;
      if (!actionsEnabled()) return;
      if (
        authenticationReconnect.attemptedByThread[current.id] ===
        state.generation
      ) {
        void authentication.requireAuthentication(current.agentId);
        return;
      }
      setAuthenticationReconnect(
        "attemptedByThread",
        current.id,
        state.generation,
      );
      untrack(() => void connect());
      return;
    }
    if (state.status === "idle") void authentication.discover(current.agentId);
  });

  return (
    <main class="flex h-full min-h-0 flex-col overflow-hidden bg-canvas text-ink">
      <Show when={model.error()}>
        {(message) => (
          <p
            role="alert"
            class="mx-6 mt-4 rounded-lg border border-line bg-panel p-3 text-sm"
          >
            {message()}
          </p>
        )}
      </Show>
      <Show when={subscriptionError()}>
        <div class="mx-6 mt-4 flex items-center gap-3 rounded-lg border border-line bg-panel p-3 text-sm">
          <p role="alert">{t("thread.subscriptionFailed")}</p>
          <Show when={retryExhausted()}>
            <button
              type="button"
              class="focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
              onClick={retrySubscription}
            >
              {t("thread.reconnect")}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={thread()}>
        <div class="relative min-h-0 flex-1">
          <ThreadTimeline
            followKey={`${thread()?.id}:${activeTurnId()}`}
            bottomInset={composerInset()}
          >
            <Show when={thread()?.status === "connecting"}>
              <p role="status">
                {thread()?.sessionId
                  ? t("thread.restoring")
                  : t("thread.connecting")}
              </p>
            </Show>
            <Show when={thread()?.interrupted}>
              <p role="status">{t("thread.interrupted")}</p>
            </Show>
            <Show when={thread()?.storageError}>
              {(message) => <p role="alert">{content(message())}</p>}
            </Show>
            <Show
              when={
                !thread()?.turns?.length &&
                thread()?.status === "sessionReady" &&
                !thread()?.notice
              }
            >
              <h2 class="text-lg font-medium">{t("thread.ready")}</h2>
              <Show when={thread()?.status === "disconnected"}>
                <p class="text-sm text-muted">{t("thread.notConnected")}</p>
              </Show>
            </Show>
            <Show when={thread()?.failure}>
              {(failure) => (
                <p role="alert" class="text-sm">
                  {t(failureKeys[failure()])}
                </p>
              )}
            </Show>
            <Show
              when={
                thread() &&
                (["agentRemoved", "executableNotFound"].includes(
                  thread()?.failure ?? "",
                ) ||
                  !props.agents.some((agent) => agent.id === thread()?.agentId))
              }
            >
              <button
                type="button"
                class="focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                onClick={props.onManage}
              >
                {t("thread.openAgentManagement")}
              </button>
            </Show>
            <Show
              when={
                thread()?.authentication === "unknown" &&
                thread()?.status === "sessionReady" &&
                !thread()?.turns?.length
              }
            >
              <p class="text-sm text-muted">
                {t("thread.authenticationUnknown")}
              </p>
            </Show>
            <Show
              when={
                !connecting() &&
                (connectFailed() ||
                  (thread()?.status === "failed" &&
                    thread()?.failure !== "authenticationRequired"))
              }
            >
              <button
                type="button"
                class="rounded-lg bg-accent px-4 py-2 text-sm text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-50"
                disabled={connecting() || thread()?.status === "connecting"}
                onClick={connect}
              >
                {t("thread.reconnect")}
              </button>
            </Show>
            <Message
              turns={thread()?.turns ?? []}
              streamingTurnId={streamingTurnId()}
            />
            <Show when={thread()?.notice}>
              {(notice) => (
                <p role="status" class="text-sm text-muted">
                  {content(notice())}
                </p>
              )}
            </Show>
          </ThreadTimeline>
          <div
            ref={(element) => {
              composerOverlay = element;
              observeComposer(element);
              setComposerHeight(element.getBoundingClientRect().height);
            }}
            class="absolute inset-x-0 bottom-4 z-10"
          >
            <Show when={thread()}>
              {(currentThread) => (
                <ThreadComposer
                  active={props.active}
                  thread={currentThread()}
                  agentName={
                    props.agents.find(
                      (agent) => agent.id === currentThread().agentId,
                    )?.name ?? currentThread().agentId
                  }
                  draft={draft()}
                  answerPending={answerPending()}
                  cancelPending={cancelPending()}
                  showStop={showStop()}
                  stopping={stopping()}
                  actionsEnabled={actionsEnabled()}
                  canSend={canSend()}
                  authentication={authentication.state(currentThread().agentId)}
                  onRetryAuthentication={() =>
                    void authentication.discover(currentThread().agentId)
                  }
                  onAuthenticate={(method) => void authenticateThread(method)}
                  onCancelAuthentication={() =>
                    void authentication.cancel(currentThread().agentId)
                  }
                  onDraftChange={setDraft}
                  onSend={() => void send()}
                  onCancel={() => void cancel()}
                  onAnswer={answer}
                  onConfigure={(configId, value) =>
                    void configure(configId, value)
                  }
                  onDeleteQueued={deleteQueued}
                />
              )}
            </Show>
          </div>
        </div>
      </Show>
    </main>
  );
}

const failureKeys: Record<ConnectionFailure, TranslationKey> = {
  executableNotFound: "thread.failure.executableNotFound",
  launchFailed: "thread.failure.launchFailed",
  initializationFailed: "thread.failure.initializationFailed",
  sessionCreationFailed: "thread.failure.sessionCreationFailed",
  authenticationRequired: "thread.failure.authenticationRequired",
  processExited: "thread.failure.processExited",
  connectionClosed: "thread.failure.connectionClosed",
  promptFailed: "thread.failure.promptFailed",
  timedOut: "thread.failure.timedOut",
  agentRemoved: "thread.failure.agentRemoved",
  resumptionUnsupported: "thread.failure.resumptionUnsupported",
  sessionRestorationFailed: "thread.failure.sessionRestorationFailed",
};
