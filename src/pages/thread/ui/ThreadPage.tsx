import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { useAgentAuthentication } from "features/agent-authentication";
import { type TranslationKey, useI18n } from "shared/i18n";
import { LanguageMenu } from "shared/ui";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  on,
  Show,
  untrack,
} from "solid-js";
import { createStore } from "solid-js/store";
import { preparedAgents } from "../api/threads";
import { createThreadModel } from "../model/thread";
import type { ConnectionFailure, Thread } from "../model/types";
import { Message } from "./Message";
import { ThreadComposer } from "./ThreadComposer";
import { ThreadSidebar } from "./ThreadSidebar";
import { ThreadTimeline } from "./ThreadTimeline";

export function ThreadPage(props: {
  active: boolean;
  agentsRevision: number;
  onManage: () => void;
}) {
  const { t, content } = useI18n();
  const authentication = useAgentAuthentication();
  const model = createThreadModel();
  const {
    thread,
    selectedThreadId,
    selecting,
    history,
    listLoading,
    listError,
    reloadList,
    connecting,
    connectFailed,
    draft,
    setDraft,
    answerPending,
    cancelPending,
    activeTurnId,
    showStop,
    stopping,
    subscriptionError,
    retryExhausted,
    actionsEnabled,
    canSend,
    openThread,
    send,
    deleteQueued,
    answer,
    cancel,
    configure,
    connect,
    removeThread,
    retrySubscription,
  } = model;
  const [agentsFailed, setAgentsFailed] = createSignal(false);
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [composerHeight, setComposerHeight] = createSignal(0);
  let composerOverlay: HTMLDivElement | undefined;
  const { observe: observeComposer } = makeResizeObserver((entries) => {
    const entry = entries.find(({ target }) => target === composerOverlay);
    if (entry) setComposerHeight(entry.contentRect.height);
  });
  const composerInset = () => composerHeight() + 32;
  const [pendingFolder, setPendingFolder] = createSignal<string>();
  const error = () =>
    model.error() ?? (agentsFailed() ? t("thread.error.agents") : undefined);
  const [agents] = createResource(
    () => props.agentsRevision,
    async () => {
      try {
        setAgentsFailed(false);
        const installed = await preparedAgents();
        return installed;
      } catch {
        setAgentsFailed(true);
        return [];
      }
    },
  );
  const [selectedAgent, setSelectedAgent] = createSignal("");
  const [authenticationReconnect, setAuthenticationReconnect] = createStore({
    attemptedByThread: {} as Record<string, number | undefined>,
    blockedByThread: {} as Record<string, number | undefined>,
    completedByAgent: {} as Record<string, number | undefined>,
  });
  let previousSelectedThreadId: string | undefined;
  const agentId = () =>
    agents()?.some((agent) => agent.id === selectedAgent())
      ? selectedAgent()
      : agents()?.[0]?.id || "";

  function selectFolder() {
    if (!agentId()) {
      props.onManage();
      return;
    }
    void model.selectFolder(agentId());
  }

  function createInFolder(folder: string) {
    if (selecting()) return;
    if (!agentId()) {
      setPendingFolder(folder);
      props.onManage();
      return;
    }
    setPendingFolder(undefined);
    void model.createInFolder(folder, agentId());
  }

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

  createEffect(
    on(
      () => [props.active, agents.loading, agentId(), pendingFolder()] as const,
      ([active, loading, agent, folder]) => {
        if (active && !loading && agent && folder) void createInFolder(folder);
      },
    ),
  );

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
    <main class="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
      <header class="flex h-14 shrink-0 items-center gap-4 border-b border-line px-6">
        <Show when={!sidebarOpen()}>
          <button
            type="button"
            aria-label={t("thread.openSidebar")}
            class="rounded p-1 text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
            onClick={() => setSidebarOpen(true)}
          >
            ◧
          </button>
        </Show>
        <span class="font-semibold tracking-tight">atte</span>
        <Show when={thread()}>
          {(currentThread) => (
            <>
              <h1 class="max-w-64 truncate text-sm font-medium">
                {content(currentThread().title) || t("common.newThread")}
              </h1>
              <span
                class="min-w-0 flex-1 truncate text-xs text-muted"
                title={currentThread().workingFolder}
              >
                {currentThread().workingFolder}
              </span>
              <span role="status" class="shrink-0 text-xs text-muted">
                {t(statusKeys[currentThread().status])}
              </span>
            </>
          )}
        </Show>
        <label class="text-xs text-muted">
          {t("thread.newThreadAgent")}
          <select
            aria-label={t("thread.newThreadAgent")}
            class="ml-2 rounded border border-line bg-panel p-1 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
            value={agentId()}
            onChange={(event) => setSelectedAgent(event.currentTarget.value)}
          >
            <For each={agents()}>
              {(agent) => <option value={agent.id}>{agent.name}</option>}
            </For>
          </select>
        </label>
        <button
          type="button"
          class="ml-auto shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-50"
          disabled={
            agentsFailed() || selecting() || agents.loading || connecting()
          }
          onClick={selectFolder}
        >
          {selecting() ? t("thread.selecting") : t("thread.selectFolder")}
        </button>
        <button
          type="button"
          class="shrink-0 text-xs text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          onClick={props.onManage}
        >
          {t("thread.manageAgents")}
        </button>
        <LanguageMenu />
      </header>
      <div class="flex min-h-0 flex-1">
        <Show when={sidebarOpen()}>
          <ThreadSidebar
            threads={history() ?? []}
            selected={selectedThreadId()}
            loading={listLoading()}
            failed={listError()}
            creating={selecting() || agents.loading || agentsFailed()}
            onRetry={() => void reloadList()}
            onSelect={(id) => void openThread(id)}
            onCreate={(folder) => void createInFolder(folder)}
            onDelete={removeThread}
            onClose={() => setSidebarOpen(false)}
          />
        </Show>
        <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Show when={error()}>
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
          <Show
            when={thread()}
            fallback={
              <section class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <h1 class="text-xl font-medium">{t("thread.empty.title")}</h1>
                <p class="text-sm text-muted">
                  {t("thread.empty.description")}
                </p>
              </section>
            }
          >
            <div class="relative min-h-0 flex-1">
              <ThreadTimeline
                followKey={`${thread()?.id}:${activeTurnId()}`}
                bottomInset={composerInset()}
              >
                <Show when={thread()?.status === "connecting"}>
                  <p role="status">
                    {thread()?.remoteSessionId
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
                      !agents()?.some(
                        (agent) => agent.id === thread()?.agentId,
                      ))
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
                <Message turns={thread()?.turns ?? []} />
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
                        agents()?.find(
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
                      authentication={authentication.state(
                        currentThread().agentId,
                      )}
                      onRetryAuthentication={() =>
                        void authentication.discover(currentThread().agentId)
                      }
                      onAuthenticate={(method) =>
                        void authenticateThread(method)
                      }
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
        </div>
      </div>
    </main>
  );
}

const statusKeys: Record<Thread["status"], TranslationKey> = {
  disconnected: "thread.status.disconnected",
  connecting: "thread.status.connecting",
  sessionReady: "thread.status.sessionReady",
  failed: "thread.status.failed",
  running: "thread.status.running",
  waitingForApproval: "thread.status.waitingForApproval",
  cancelling: "thread.status.cancelling",
};

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
