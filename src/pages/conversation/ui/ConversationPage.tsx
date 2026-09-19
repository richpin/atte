import {
  createEffect,
  createResource,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
import { preparedAgents } from "../api/conversations";
import { createConversationModel } from "../model/conversation";
import { failureMessages, statusLabels } from "../model/types";
import { ConversationHistory } from "./ConversationHistory";
import { ConversationSidebar } from "./ConversationSidebar";
import { PermissionPanel } from "./PermissionPanel";
import { QueuedMessages } from "./QueuedMessages";
import { Transcript } from "./Transcript";

export function ConversationPage(props: {
  active: boolean;
  agentsRevision: number;
  onManage: () => void;
}) {
  const model = createConversationModel();
  const {
    conversation,
    selecting,
    history,
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
    openConversation,
    send,
    deleteQueued,
    answer,
    cancel,
    connect,
    retrySubscription,
  } = model;
  const [agentsFailed, setAgentsFailed] = createSignal(false);
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [pendingFolder, setPendingFolder] = createSignal<string>();
  const error = () =>
    model.error() ??
    (agentsFailed() ? "준비된 에이전트를 불러올 수 없습니다." : undefined);
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

  return (
    <main class="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
      <header class="flex h-14 shrink-0 items-center gap-4 border-b border-line px-6">
        <Show when={!sidebarOpen()}>
          <button
            type="button"
            aria-label="사이드바 열기"
            class="rounded p-1 text-muted"
            onClick={() => setSidebarOpen(true)}
          >
            ◧
          </button>
        </Show>
        <span class="font-semibold tracking-tight">atte</span>
        <Show when={conversation()}>
          {(draft) => (
            <>
              <h1 class="max-w-64 truncate text-sm font-medium">
                {draft().title || "새 대화"}
              </h1>
              <span
                class="min-w-0 flex-1 truncate text-xs text-muted"
                title={draft().workingFolder}
              >
                {draft().workingFolder}
              </span>
              <span role="status" class="shrink-0 text-xs text-muted">
                {statusLabels[draft().status]}
              </span>
            </>
          )}
        </Show>
        <label class="text-xs text-muted">
          새 대화 에이전트
          <select
            aria-label="새 대화 에이전트"
            class="ml-2 rounded border border-line bg-panel p-1"
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
          class="ml-auto shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs hover:bg-panel disabled:opacity-50"
          disabled={
            agentsFailed() || selecting() || agents.loading || connecting()
          }
          onClick={selectFolder}
        >
          {selecting() ? "선택 중…" : "폴더 선택"}
        </button>
        <button
          type="button"
          class="shrink-0 text-xs text-muted"
          onClick={props.onManage}
        >
          에이전트 관리
        </button>
      </header>
      <div class="flex min-h-0 flex-1">
        <Show when={sidebarOpen()}>
          <ConversationSidebar
            conversations={history() ?? []}
            selected={conversation()?.id}
            loading={history.loading}
            failed={listError()}
            creating={selecting() || agents.loading || agentsFailed()}
            onRetry={() => void reloadList()}
            onSelect={(id) => void openConversation(id)}
            onCreate={(folder) => void createInFolder(folder)}
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
            when={conversation()}
            fallback={
              <section class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <h1 class="text-xl font-medium">어디에서 작업할까요?</h1>
                <p class="text-sm text-muted">
                  폴더를 선택해 새 대화를 준비하세요.
                </p>
              </section>
            }
          >
            <ConversationHistory
              followKey={`${conversation()?.id}:${activeTurn()}`}
            >
              <Show when={conversation()?.status === "connecting"}>
                <p role="status">
                  {conversation()?.remoteSessionId
                    ? "이전 대화를 불러오는 중…"
                    : "에이전트에 연결 중…"}
                </p>
              </Show>
              <Show when={conversation()?.interrupted}>
                <p role="status">
                  이전 작업이 중단되었습니다. 새 메시지를 보내 계속할 수
                  있습니다.
                </p>
              </Show>
              <Show when={conversation()?.storageError}>
                {(message) => <p role="alert">{message()}</p>}
              </Show>
              <Show
                when={
                  !conversation()?.turns?.length &&
                  conversation()?.status === "sessionReady" &&
                  !conversation()?.notice
                }
              >
                <h2 class="text-lg font-medium">대화가 준비되었습니다</h2>
                <Show when={conversation()?.status === "disconnected"}>
                  <p class="text-sm text-muted">
                    아직 에이전트에 연결되지 않았습니다.
                  </p>
                </Show>
              </Show>
              <Show when={streamError()}>
                <p role="alert">대화 상태를 구독할 수 없습니다.</p>
                <button type="button" onClick={retrySubscription}>
                  상태 다시 불러오기
                </button>
              </Show>
              <Show when={conversation()?.failure}>
                {(failure) => (
                  <p role="alert" class="text-sm">
                    {failureMessages[failure()]}
                  </p>
                )}
              </Show>
              <Show when={conversation()?.failure === "authenticationRequired"}>
                <button type="button" onClick={props.onManage}>
                  로그인 안내 열기
                </button>
              </Show>
              <Show
                when={
                  conversation() &&
                  (["agentRemoved", "executableNotFound"].includes(
                    conversation()?.failure ?? "",
                  ) ||
                    !agents()?.some(
                      (agent) => agent.id === conversation()?.agentId,
                    ))
                }
              >
                <button type="button" onClick={props.onManage}>
                  설치·인증 관리 열기
                </button>
              </Show>
              <Show
                when={
                  conversation()?.authentication === "unknown" &&
                  conversation()?.status === "sessionReady" &&
                  !conversation()?.turns?.length
                }
              >
                <p class="text-sm text-muted">
                  인증 상태는 아직 확인되지 않았습니다.
                </p>
              </Show>
              <Show
                when={
                  !connecting() &&
                  (conversation()?.status === "failed" || connectionRejected())
                }
              >
                <button
                  type="button"
                  class="rounded-lg bg-accent px-4 py-2 text-sm text-white disabled:opacity-50"
                  disabled={
                    connecting() || conversation()?.status === "connecting"
                  }
                  onClick={connect}
                >
                  다시 연결
                </button>
              </Show>
              <Transcript turns={conversation()?.turns ?? []} />
              <Show when={conversation()?.notice}>
                {(notice) => (
                  <p role="status" class="text-sm text-muted">
                    {notice()}
                  </p>
                )}
              </Show>
            </ConversationHistory>
            <div class="mx-auto mb-6 w-full max-w-3xl shrink-0 px-6">
              <QueuedMessages
                messages={conversation()?.queuedMessages ?? []}
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
                  when={conversation()?.permissions?.[0]}
                  fallback={
                    <textarea
                      aria-label="메시지"
                      aria-describedby="connection-note"
                      class="w-full resize-none bg-transparent text-sm disabled:cursor-not-allowed"
                      disabled={
                        sending() ||
                        !["sessionReady", "running", "cancelling"].includes(
                          conversation()?.status ?? "",
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
                      placeholder="메시지를 입력하세요"
                    />
                  }
                >
                  {(request) => (
                    <PermissionPanel
                      request={request()}
                      workingFolder={conversation()?.workingFolder ?? ""}
                      disabled={Boolean(answering()) || Boolean(cancelling())}
                      onAnswer={answer}
                    />
                  )}
                </Show>
                <div class="mt-3 flex items-center justify-between text-xs text-muted">
                  <span>
                    {agents()?.find(
                      (agent) => agent.id === conversation()?.agentId,
                    )?.name ?? conversation()?.agentId}
                  </span>
                  <button
                    type={showStop() ? "button" : "submit"}
                    aria-label={showStop() ? "현재 작업 중단" : "전송"}
                    class="rounded-lg bg-accent px-4 py-2 text-white disabled:opacity-40"
                    disabled={
                      showStop() ? stopping() : !canSend() || !message().trim()
                    }
                    onClick={() => {
                      if (showStop()) void cancel();
                    }}
                  >
                    {showStop() ? "중단" : "전송"}
                  </button>
                </div>
              </form>
              <p
                id="connection-note"
                class="mt-2 text-center text-xs text-muted"
              >
                {conversation()?.status === "running"
                  ? "작업 중에도 다음 메시지를 입력할 수 있습니다."
                  : "연결된 대화에 메시지를 보내세요."}
              </p>
            </div>
          </Show>
        </div>
      </div>
    </main>
  );
}
