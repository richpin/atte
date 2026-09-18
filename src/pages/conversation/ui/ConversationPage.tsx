import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  answerPermission,
  cancelTurn,
  connectConversation,
  createConversation,
  deleteQueuedMessage,
  getConversation,
  listConversations,
  preparedAgents,
  selectWorkingFolder,
  sendMessage,
  subscribeConversation,
  subscribeConversationList,
} from "../api/conversations";
import {
  type Conversation,
  type ConversationMetadata,
  type ConversationUpdate,
  failureMessages,
  statusLabels,
} from "../model/types";
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
  const [conversation, setConversation] = createSignal<Conversation>();
  const [error, setError] = createSignal<string>();
  const [agentsFailed, setAgentsFailed] = createSignal(false);
  const [selecting, setSelecting] = createSignal(false);
  const [listError, setListError] = createSignal(false);
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [pendingFolder, setPendingFolder] = createSignal<string>();
  let listVersion = 0;
  const [history, { refetch: reloadList, mutate: updateList }] = createResource(
    async (): Promise<ConversationMetadata[]> => {
      try {
        const version = listVersion;
        setListError(false);
        const entries = await listConversations();
        return version === listVersion ? entries : (history() ?? entries);
      } catch {
        setListError(true);
        return [];
      }
    },
  );
  onMount(() => {
    onCleanup(
      subscribeConversationList(
        (entries) => {
          listVersion++;
          updateList(entries);
          setListError(false);
        },
        () => setListError(true),
      ),
    );
  });

  const [agents] = createResource(
    () => props.agentsRevision,
    async () => {
      try {
        setAgentsFailed(false);
        const installed = await preparedAgents();
        return installed;
      } catch {
        setAgentsFailed(true);
        setError("준비된 에이전트를 불러올 수 없습니다.");
        return [];
      }
    },
  );
  const [selectedAgent, setSelectedAgent] = createSignal("");
  const agentId = () =>
    agents()?.some((agent) => agent.id === selectedAgent())
      ? selectedAgent()
      : agents()?.[0]?.id || "";
  const [connectingId, setConnectingId] = createSignal<string>();
  const connecting = () =>
    Boolean(connectingId()) && connectingId() === conversation()?.id;
  const [connectionRejected, setConnectionRejected] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [answering, setAnswering] = createSignal<string>();
  const [cancelling, setCancelling] = createSignal<string>();
  const activeTurn = () => conversation()?.turns?.at(-1)?.id;
  const canCancel = () =>
    ["running", "waitingForApproval"].includes(conversation()?.status ?? "");
  const showStop = () => canCancel() || conversation()?.status === "cancelling";
  const stopping = () =>
    Boolean(cancelling()) || conversation()?.status === "cancelling";
  const [streamError, setStreamError] = createSignal(false);
  const [subscriptionAttempt, setSubscriptionAttempt] = createSignal(0);
  const canSend = () =>
    ["sessionReady", "running", "cancelling"].includes(
      conversation()?.status ?? "",
    ) &&
    !sending() &&
    !streamError();

  function applyConversation(updatedConversation: Conversation) {
    const current = conversation();
    if (
      current?.id === updatedConversation.id &&
      updatedConversation.revision >= current.revision
    ) {
      remember(updatedConversation);
      setConversation(updatedConversation);
    }
  }

  function remember(updatedConversation: Conversation) {
    listVersion++;
    const {
      id,
      title,
      workingFolder,
      agentId,
      status,
      remoteSessionId,
      createdAt,
      updatedAt,
      failure,
      interrupted,
    } = updatedConversation;
    const metadata = {
      id,
      title,
      workingFolder,
      agentId,
      status,
      remoteSessionId,
      createdAt,
      updatedAt,
      failure,
      interrupted,
    };
    updateList((previous) => [
      metadata,
      ...(previous ?? []).filter((entry) => entry.id !== id),
    ]);
  }

  let selection = 0;
  async function openConversation(id: string) {
    if (conversation()?.id === id) return;
    const attempt = ++selection;
    setError(undefined);
    try {
      const updatedConversation = await getConversation(id);
      if (attempt !== selection) return;
      setConversation(updatedConversation);
      setMessage("");
      setConnectionRejected(false);
      if (updatedConversation.status === "disconnected") void connect();
    } catch (cause) {
      if (attempt === selection)
        setError(errorMessage(cause, "대화를 열 수 없습니다."));
    }
  }

  function applyUpdate(update: ConversationUpdate) {
    if (update.kind === "conversation") {
      applyConversation(update.conversation);
      return;
    }
    const current = conversation();
    if (
      !current ||
      update.conversationId !== current.id ||
      update.revision <= current.revision
    )
      return;
    if (
      update.revision !== current.revision + 1 ||
      current.turns.at(-1)?.id !== update.turnId
    ) {
      setStreamError(true);
      return;
    }
    setConversation({
      ...current,
      revision: update.revision,
      turns: current.turns.map((turn) =>
        turn.id === update.turnId
          ? { ...turn, response: turn.response + update.text }
          : turn,
      ),
    });
  }

  const conversationId = createMemo(() => conversation()?.id);
  createEffect(
    on(
      () => [conversationId(), subscriptionAttempt()] as const,
      ([id]) => {
        if (!id) return;
        setStreamError(false);
        onCleanup(
          subscribeConversation(id, applyUpdate, () => setStreamError(true)),
        );
      },
    ),
  );

  async function send() {
    const current = conversation();
    if (!current || !canSend() || !message().trim()) return;
    setSending(true);
    setError(undefined);
    try {
      const updatedConversation = await sendMessage(current.id, message());
      if (conversation()?.id === current.id) {
        applyConversation(updatedConversation);
        setMessage("");
      }
    } catch (cause) {
      if (conversation()?.id === current.id)
        setError(errorMessage(cause, "메시지를 전송할 수 없습니다."));
    } finally {
      setSending(false);
    }
  }

  async function deleteQueued(id: string) {
    const current = conversation();
    if (!current) return;
    try {
      const updatedConversation = await deleteQueuedMessage(current.id, id);
      applyConversation(updatedConversation);
    } catch (cause) {
      if (conversation()?.id === current.id)
        setError(errorMessage(cause, "대기 메시지를 삭제할 수 없습니다."));
    }
  }

  async function answer(request: string, option: string) {
    const current = conversation();
    if (!current || answering() || cancelling()) return;
    setAnswering(request);
    setError(undefined);
    try {
      applyConversation(await answerPermission(current.id, request, option));
    } catch (cause) {
      if (conversation()?.id === current.id)
        setError(errorMessage(cause, "승인 응답을 전달할 수 없습니다."));
    } finally {
      setAnswering(undefined);
    }
  }

  async function cancel() {
    const current = conversation();
    const turn = activeTurn();
    if (!current || !turn || !canCancel() || cancelling()) return;
    setCancelling(turn);
    setError(undefined);
    try {
      applyConversation(await cancelTurn(current.id, turn));
    } catch (cause) {
      if (conversation()?.id === current.id)
        setError(errorMessage(cause, "작업을 중단할 수 없습니다."));
    } finally {
      setCancelling(undefined);
    }
  }

  async function connect() {
    const draft = conversation();
    if (!draft || connecting()) return;
    setConnectingId(draft.id);
    setConnectionRejected(false);
    setError(undefined);
    try {
      const updatedConversation = await connectConversation(draft.id);
      if (conversation()?.id === draft.id)
        applyConversation(updatedConversation);
    } catch (cause) {
      if (conversation()?.id === draft.id) {
        setConnectionRejected(true);
        setError(
          errorMessage(cause, "연결을 시작할 수 없습니다. 다시 시도해주세요."),
        );
      }
    } finally {
      if (connectingId() === draft.id) setConnectingId(undefined);
    }
  }

  async function selectFolder() {
    if (!agentId()) {
      props.onManage();
      return;
    }
    if (selecting()) return;
    setSelecting(true);
    setError(undefined);
    try {
      const draft = await selectWorkingFolder(agentId());
      if (draft) {
        ++selection;
        setConversation(draft);
        remember(draft);
        setMessage("");
        setConnectionRejected(false);
        if (draft.status === "disconnected") void connect();
      }
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          "폴더 선택을 완료할 수 없습니다. 다시 시도해주세요.",
        ),
      );
    } finally {
      setSelecting(false);
    }
  }

  async function createInFolder(folder: string) {
    if (selecting()) return;
    if (!agentId()) {
      setPendingFolder(folder);
      props.onManage();
      return;
    }
    setPendingFolder(undefined);
    setSelecting(true);
    setError(undefined);
    const attempt = ++selection;
    try {
      const draft = await createConversation(folder, agentId());
      remember(draft);
      if (attempt !== selection) return;
      setConversation(draft);
      setMessage("");
      setConnectionRejected(false);
      if (draft.status === "disconnected") void connect();
    } catch (cause) {
      if (attempt === selection)
        setError(errorMessage(cause, "새 대화를 만들 수 없습니다."));
    } finally {
      setSelecting(false);
    }
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
                <button
                  type="button"
                  onClick={() => setSubscriptionAttempt((value) => value + 1)}
                >
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

function errorMessage(cause: unknown, fallback: string): string {
  return typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
    ? cause.message
    : fallback;
}
