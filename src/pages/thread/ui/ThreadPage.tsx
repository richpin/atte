import { type TranslationKey, useI18n } from "shared/i18n";
import { LanguageMenu } from "shared/ui";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
import { preparedAgents } from "../api/threads";
import { createThreadModel } from "../model/thread";
import type { ConnectionFailure, Thread } from "../model/types";
import { PermissionPanel } from "./PermissionPanel";
import { QueuedMessages } from "./QueuedMessages";
import { ThreadHistory } from "./ThreadHistory";
import { ThreadSidebar } from "./ThreadSidebar";
import { Transcript } from "./Transcript";

export function ThreadPage(props: {
  active: boolean;
  agentsRevision: number;
  onManage: () => void;
}) {
  const { t, content } = useI18n();
  const model = createThreadModel();
  const {
    thread,
    selecting,
    history,
    listLoading,
    listError,
    reloadList,
    connecting,
    connectionRejected,
    message,
    setMessage,
    sending,
    answering,
    cancelling,
    activeTurn,
    showStop,
    stopping,
    streamError,
    canSend,
    openThread,
    send,
    deleteQueued,
    answer,
    cancel,
    connect,
    removeThread,
    retrySubscription,
  } = model;
  const [agentsFailed, setAgentsFailed] = createSignal(false);
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
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
  let messageInput: HTMLTextAreaElement | undefined;
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

  createEffect(
    on(
      () => [props.active, agents.loading, agentId(), pendingFolder()] as const,
      ([active, loading, agent, folder]) => {
        if (active && !loading && agent && folder) void createInFolder(folder);
      },
    ),
  );

  createEffect(
    on(
      () => [props.active, thread()?.id, thread()?.status] as const,
      ([active, , status]) => {
        if (active && status === "sessionReady") messageInput?.focus();
      },
    ),
  );

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
          {(draft) => (
            <>
              <h1 class="max-w-64 truncate text-sm font-medium">
                {content(draft().title) || t("common.newThread")}
              </h1>
              <span
                class="min-w-0 flex-1 truncate text-xs text-muted"
                title={draft().workingFolder}
              >
                {draft().workingFolder}
              </span>
              <span role="status" class="shrink-0 text-xs text-muted">
                {t(statusKeys[draft().status])}
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
            selected={thread()?.id}
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
            <ThreadHistory followKey={`${thread()?.id}:${activeTurn()}`}>
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
              <Show when={streamError()}>
                <p role="alert">{t("thread.subscriptionFailed")}</p>
                <button
                  type="button"
                  class="focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                  onClick={retrySubscription}
                >
                  {t("thread.reloadStatus")}
                </button>
              </Show>
              <Show when={thread()?.failure}>
                {(failure) => (
                  <p role="alert" class="text-sm">
                    {t(failureKeys[failure()])}
                  </p>
                )}
              </Show>
              <Show when={thread()?.failure === "authenticationRequired"}>
                <button
                  type="button"
                  class="focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                  onClick={props.onManage}
                >
                  {t("thread.openSignIn")}
                </button>
              </Show>
              <Show
                when={
                  thread() &&
                  (["agentRemoved", "executableNotFound"].includes(
                    thread()?.failure ?? "",
                  ) ||
                    !agents()?.some((agent) => agent.id === thread()?.agentId))
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
                  (thread()?.status === "failed" || connectionRejected())
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
              <Transcript turns={thread()?.turns ?? []} />
              <Show when={thread()?.notice}>
                {(notice) => (
                  <p role="status" class="text-sm text-muted">
                    {content(notice())}
                  </p>
                )}
              </Show>
            </ThreadHistory>
            <div class="mx-auto mb-6 w-full max-w-4xl shrink-0 px-6">
              <QueuedMessages
                messages={thread()?.queuedMessages ?? []}
                onDelete={deleteQueued}
              />
              <form
                class="max-h-[60dvh] overflow-y-auto rounded-2xl border border-line bg-panel p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <Show
                  when={thread()?.permissions?.[0]}
                  fallback={
                    <textarea
                      ref={messageInput}
                      aria-label={t("thread.message")}
                      aria-describedby="connection-note"
                      class="w-full resize-none bg-transparent text-sm outline-none disabled:cursor-not-allowed"
                      disabled={
                        sending() ||
                        !["sessionReady", "running", "cancelling"].includes(
                          thread()?.status ?? "",
                        )
                      }
                      value={message()}
                      onInput={(event) => setMessage(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "Enter" ||
                          event.shiftKey ||
                          event.isComposing ||
                          event.keyCode === 229
                        )
                          return;
                        event.preventDefault();
                        if (!event.repeat) void send();
                      }}
                      rows={2}
                      placeholder={t("thread.messagePlaceholder")}
                    />
                  }
                >
                  {(request) => (
                    <PermissionPanel
                      request={request()}
                      workingFolder={thread()?.workingFolder ?? ""}
                      disabled={Boolean(answering()) || Boolean(cancelling())}
                      onAnswer={answer}
                    />
                  )}
                </Show>
                <div class="mt-3 flex items-center justify-between text-xs text-muted">
                  <span>
                    {agents()?.find((agent) => agent.id === thread()?.agentId)
                      ?.name ?? thread()?.agentId}
                  </span>
                  <button
                    type={showStop() ? "button" : "submit"}
                    aria-label={
                      showStop() ? t("thread.stop") : t("thread.send")
                    }
                    class="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
                    disabled={
                      showStop() ? stopping() : !canSend() || !message().trim()
                    }
                    onClick={() => {
                      if (showStop()) void cancel();
                    }}
                  >
                    <Show
                      when={showStop()}
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
              <p
                id="connection-note"
                class="mt-2 text-center text-xs text-muted"
              >
                {thread()?.status === "running"
                  ? t("thread.composer.running")
                  : t("thread.composer.ready")}
              </p>
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
