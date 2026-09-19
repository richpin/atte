import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import {
  answerPermission,
  cancelTurn,
  connectConversation,
  createConversation,
  deleteQueuedMessage,
  getConversation,
  listConversations,
  selectWorkingFolder,
  sendMessage,
  subscribeConversation,
  subscribeConversationList,
} from "../api/conversations";
import type {
  Conversation,
  ConversationMetadata,
  ConversationUpdate,
} from "./types";

/** Owns synchronization for one conversation view; call inside a Solid owner. */
export function createConversationModel() {
  const [conversation, setConversation] = createSignal<Conversation>();
  const [error, setError] = createSignal<string>();
  const [selecting, setSelecting] = createSignal(false);
  const [listError, setListError] = createSignal(false);
  let disposed = false;
  let selection = 0;
  let view = 0;
  onCleanup(() => {
    disposed = true;
    selection++;
    view++;
  });
  let listVersion = 0;
  const [history, { refetch: reloadList, mutate: updateList }] = createResource(
    async (): Promise<ConversationMetadata[]> => {
      const version = listVersion;
      try {
        setListError(false);
        const entries = await listConversations();
        return version === listVersion ? entries : (history() ?? entries);
      } catch {
        if (version !== listVersion || disposed) return history() ?? [];
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

  // A command belongs to the displayed view, even when the same conversation
  // is opened again later. Its completion must not mutate that newer view.
  function isCurrent(expectedView: number) {
    return !disposed && view === expectedView;
  }

  function display(updatedConversation: Conversation) {
    view++;
    setError(undefined);
    setSending(false);
    setAnswering(undefined);
    setCancelling(undefined);
    setConnectingId(undefined);
    setMessage("");
    setConnectionRejected(false);
    setConversation(updatedConversation);
    if (updatedConversation.status === "disconnected") void connect();
  }

  async function openConversation(id: string) {
    const attempt = ++selection;
    if (conversation()?.id === id || disposed) return;
    setError(undefined);
    try {
      const updatedConversation = await getConversation(id);
      if (attempt !== selection) return;
      display(updatedConversation);
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
    const expectedView = view;
    const current = conversation();
    if (!current || !canSend() || !message().trim()) return;
    setSending(true);
    setError(undefined);
    try {
      const updatedConversation = await sendMessage(current.id, message());
      if (isCurrent(expectedView)) {
        applyConversation(updatedConversation);
        setMessage("");
      }
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(errorMessage(cause, "메시지를 전송할 수 없습니다."));
    } finally {
      if (isCurrent(expectedView)) setSending(false);
    }
  }

  async function deleteQueued(id: string) {
    const expectedView = view;
    const current = conversation();
    if (!current) return;
    try {
      const updatedConversation = await deleteQueuedMessage(current.id, id);
      if (isCurrent(expectedView)) applyConversation(updatedConversation);
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(errorMessage(cause, "대기 메시지를 삭제할 수 없습니다."));
    }
  }

  async function answer(request: string, option: string) {
    const expectedView = view;
    const current = conversation();
    if (!current || answering() || cancelling()) return;
    setAnswering(request);
    setError(undefined);
    try {
      const updated = await answerPermission(current.id, request, option);
      if (isCurrent(expectedView)) applyConversation(updated);
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(errorMessage(cause, "승인 응답을 전달할 수 없습니다."));
    } finally {
      if (isCurrent(expectedView)) setAnswering(undefined);
    }
  }

  async function cancel() {
    const expectedView = view;
    const current = conversation();
    const turn = activeTurn();
    if (!current || !turn || !canCancel() || cancelling()) return;
    setCancelling(turn);
    setError(undefined);
    try {
      const updated = await cancelTurn(current.id, turn);
      if (isCurrent(expectedView)) applyConversation(updated);
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(errorMessage(cause, "작업을 중단할 수 없습니다."));
    } finally {
      if (isCurrent(expectedView)) setCancelling(undefined);
    }
  }

  async function connect() {
    const expectedView = view;
    const draft = conversation();
    if (!draft || connecting()) return;
    setConnectingId(draft.id);
    setConnectionRejected(false);
    setError(undefined);
    try {
      const updatedConversation = await connectConversation(draft.id);
      if (isCurrent(expectedView)) applyConversation(updatedConversation);
    } catch (cause) {
      if (isCurrent(expectedView)) {
        setConnectionRejected(true);
        setError(
          errorMessage(cause, "연결을 시작할 수 없습니다. 다시 시도해주세요."),
        );
      }
    } finally {
      if (isCurrent(expectedView)) setConnectingId(undefined);
    }
  }

  async function selectFolder(agentId: string) {
    if (selecting()) return;
    setSelecting(true);
    setError(undefined);
    const attempt = ++selection;
    try {
      const draft = await selectWorkingFolder(agentId);
      if (draft) {
        if (disposed) return;
        remember(draft);
        if (attempt === selection) display(draft);
      }
    } catch (cause) {
      if (attempt !== selection) return;
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

  async function createInFolder(folder: string, agentId: string) {
    if (selecting()) return;
    setSelecting(true);
    setError(undefined);
    const attempt = ++selection;
    try {
      const draft = await createConversation(folder, agentId);
      if (disposed) return;
      remember(draft);
      if (attempt !== selection) return;
      display(draft);
    } catch (cause) {
      if (attempt === selection)
        setError(errorMessage(cause, "새 대화를 만들 수 없습니다."));
    } finally {
      setSelecting(false);
    }
  }

  return {
    conversation,
    error,
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
    selectFolder,
    createInFolder,
    retrySubscription: () => setSubscriptionAttempt((value) => value + 1),
  };
}

function errorMessage(cause: unknown, fallback: string): string {
  return typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
    ? cause.message
    : fallback;
}
