import {
  createQuery,
  type QueryClient,
  useQueryClient,
} from "@tanstack/solid-query";
import { useI18n } from "shared/i18n";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import {
  answerPermission,
  cancelTurn,
  connectThread,
  createThread,
  deleteQueuedMessage,
  deleteThread as deleteThreadCommand,
  getThread,
  listThreads,
  selectWorkingFolder,
  sendMessage,
  subscribeThread,
  subscribeThreadList,
} from "../api/threads";
import type { Thread, ThreadMetadata, ThreadUpdate } from "./types";

const threadListQueryKey = ["threads"] as const;

function sortThreads(entries: ThreadMetadata[]) {
  return entries.toSorted(
    (left, right) =>
      right.lastPromptAt - left.lastPromptAt || left.id.localeCompare(right.id),
  );
}

/** Owns synchronization for one thread view; call inside a Solid owner. */
export function createThreadModel(queryClient?: QueryClient) {
  const { message: localizedMessage, t } = useI18n();
  const client = useQueryClient(queryClient);
  const [thread, setThread] = createSignal<Thread>();
  const [error, setError] = createSignal<string>();
  const [selecting, setSelecting] = createSignal(false);
  const [listSubscriptionError, setListSubscriptionError] = createSignal(false);
  let disposed = false;
  const deleted = new Set<string>();
  let selection = 0;
  let view = 0;
  onCleanup(() => {
    disposed = true;
    selection++;
    view++;
  });
  const historyQuery = createQuery(
    () => ({
      queryKey: threadListQueryKey,
      queryFn: async () =>
        (await listThreads()).filter((entry) => !deleted.has(entry.id)),
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
    }),
    () => client,
  );
  const history = createMemo(() => historyQuery.data ?? []);
  const listLoading = () => historyQuery.isFetching;
  const listError = () => listSubscriptionError() || historyQuery.isError;
  const reloadList = () => {
    setListSubscriptionError(false);
    return historyQuery.refetch();
  };

  function replaceThreadList(entries: ThreadMetadata[]) {
    void client.cancelQueries({ queryKey: threadListQueryKey });
    client.setQueryData(
      threadListQueryKey,
      sortThreads(entries.filter((entry) => !deleted.has(entry.id))),
    );
  }

  onMount(() => {
    onCleanup(
      subscribeThreadList(
        (entries) => {
          replaceThreadList(entries);
          setListSubscriptionError(false);
        },
        () => setListSubscriptionError(true),
      ),
    );
  });

  const [connectingId, setConnectingId] = createSignal<string>();
  const connecting = () =>
    Boolean(connectingId()) && connectingId() === thread()?.id;
  const [connectionRejected, setConnectionRejected] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [answering, setAnswering] = createSignal<string>();
  const [cancelling, setCancelling] = createSignal<string>();
  const activeTurn = () => thread()?.turns?.at(-1)?.id;
  const canCancel = () =>
    ["running", "waitingForApproval"].includes(thread()?.status ?? "");
  const showStop = () => canCancel() || thread()?.status === "cancelling";
  const stopping = () =>
    Boolean(cancelling()) || thread()?.status === "cancelling";
  const [streamError, setStreamError] = createSignal(false);
  const [subscriptionAttempt, setSubscriptionAttempt] = createSignal(0);
  const canSend = () =>
    ["sessionReady", "running", "cancelling"].includes(
      thread()?.status ?? "",
    ) &&
    !sending() &&
    !streamError();

  function applyThread(updatedThread: Thread) {
    if (deleted.has(updatedThread.id)) return;
    const current = thread();
    if (
      current?.id === updatedThread.id &&
      updatedThread.revision >= current.revision
    ) {
      updateThreadInList(updatedThread);
      setThread(updatedThread);
    }
  }

  function updateThreadInList(updatedThread: Thread) {
    if (deleted.has(updatedThread.id)) return;
    const {
      id,
      title,
      workingFolder,
      agentId,
      status,
      remoteSessionId,
      createdAt,
      updatedAt,
      lastPromptAt,
      failure,
      interrupted,
    } = updatedThread;
    const metadata = {
      id,
      title,
      workingFolder,
      agentId,
      status,
      remoteSessionId,
      createdAt,
      updatedAt,
      lastPromptAt,
      failure,
      interrupted,
    };
    void client.cancelQueries({ queryKey: threadListQueryKey });
    client.setQueryData<ThreadMetadata[]>(threadListQueryKey, (previous) =>
      sortThreads([
        metadata,
        ...(previous ?? []).filter((entry) => entry.id !== id),
      ]),
    );
  }

  // A command belongs to the displayed view, even when the same thread
  // is opened again later. Its completion must not mutate that newer view.
  function isCurrent(expectedView: number) {
    return !disposed && view === expectedView;
  }

  function display(updatedThread: Thread) {
    if (deleted.has(updatedThread.id)) return;
    view++;
    setError(undefined);
    setSending(false);
    setAnswering(undefined);
    setCancelling(undefined);
    setConnectingId(undefined);
    setMessage("");
    setConnectionRejected(false);
    setThread(updatedThread);
    if (updatedThread.status === "disconnected") void connect();
  }

  async function openThread(id: string) {
    const attempt = ++selection;
    if (thread()?.id === id || disposed) return;
    setError(undefined);
    try {
      const updatedThread = await getThread(id);
      if (attempt !== selection || deleted.has(id)) return;
      display(updatedThread);
    } catch (cause) {
      if (attempt === selection)
        setError(localizedMessage(cause, "thread.error.open"));
    }
  }

  function applyUpdate(update: ThreadUpdate) {
    if (update.kind === "thread") {
      applyThread(update.thread);
      return;
    }
    const current = thread();
    if (
      !current ||
      update.threadId !== current.id ||
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
    setThread({
      ...current,
      revision: update.revision,
      turns: current.turns.map((turn) =>
        turn.id === update.turnId
          ? { ...turn, response: turn.response + update.text }
          : turn,
      ),
    });
  }

  const threadId = createMemo(() => thread()?.id);
  createEffect(
    on(
      () => [threadId(), subscriptionAttempt()] as const,
      ([id]) => {
        if (!id) return;
        setStreamError(false);
        onCleanup(subscribeThread(id, applyUpdate, () => setStreamError(true)));
      },
    ),
  );

  async function send() {
    const expectedView = view;
    const current = thread();
    if (!current || !canSend() || !message().trim()) return;
    setSending(true);
    setError(undefined);
    try {
      const updatedThread = await sendMessage(current.id, message());
      if (isCurrent(expectedView)) {
        applyThread(updatedThread);
        setMessage("");
      }
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(localizedMessage(cause, "thread.error.send"));
    } finally {
      if (isCurrent(expectedView)) setSending(false);
    }
  }

  async function deleteQueued(id: string) {
    const expectedView = view;
    const current = thread();
    if (!current) return;
    try {
      const updatedThread = await deleteQueuedMessage(current.id, id);
      if (isCurrent(expectedView)) applyThread(updatedThread);
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(localizedMessage(cause, "thread.error.deleteQueued"));
    }
  }

  async function answer(request: string, option: string) {
    const expectedView = view;
    const current = thread();
    if (!current || answering() || cancelling()) return;
    setAnswering(request);
    setError(undefined);
    try {
      const updated = await answerPermission(current.id, request, option);
      if (isCurrent(expectedView)) applyThread(updated);
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(localizedMessage(cause, "thread.error.answerPermission"));
    } finally {
      if (isCurrent(expectedView)) setAnswering(undefined);
    }
  }

  async function cancel() {
    const expectedView = view;
    const current = thread();
    const turn = activeTurn();
    if (!current || !turn || !canCancel() || cancelling()) return;
    setCancelling(turn);
    setError(undefined);
    try {
      const updated = await cancelTurn(current.id, turn);
      if (isCurrent(expectedView)) applyThread(updated);
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(localizedMessage(cause, "thread.error.cancel"));
    } finally {
      if (isCurrent(expectedView)) setCancelling(undefined);
    }
  }

  async function connect() {
    const expectedView = view;
    const draft = thread();
    if (!draft || connecting()) return;
    setConnectingId(draft.id);
    setConnectionRejected(false);
    setError(undefined);
    try {
      const updatedThread = await connectThread(draft.id);
      if (isCurrent(expectedView)) applyThread(updatedThread);
    } catch (cause) {
      if (isCurrent(expectedView)) {
        setConnectionRejected(true);
        setError(localizedMessage(cause, "thread.error.connect"));
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
      const draft = await selectWorkingFolder(
        agentId,
        t("thread.folderDialogTitle"),
      );
      if (draft) {
        if (disposed) return;
        updateThreadInList(draft);
        if (attempt === selection) display(draft);
      }
    } catch (cause) {
      if (attempt !== selection) return;
      setError(localizedMessage(cause, "thread.error.selectFolder"));
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
      const draft = await createThread(folder, agentId);
      if (disposed) return;
      updateThreadInList(draft);
      if (attempt !== selection) return;
      display(draft);
    } catch (cause) {
      if (attempt === selection)
        setError(localizedMessage(cause, "thread.error.create"));
    } finally {
      setSelecting(false);
    }
  }

  async function removeThread(id: string) {
    await deleteThreadCommand(id);
    deleted.add(id);
    void client.cancelQueries({ queryKey: threadListQueryKey });
    client.setQueryData<ThreadMetadata[]>(threadListQueryKey, (previous) =>
      (previous ?? []).filter((entry) => entry.id !== id),
    );
    if (thread()?.id !== id) return;
    selection++;
    view++;
    setThread(undefined);
    setError(undefined);
    setSending(false);
    setAnswering(undefined);
    setCancelling(undefined);
    setConnectingId(undefined);
    setMessage("");
    setConnectionRejected(false);
    setStreamError(false);
  }

  return {
    thread,
    error,
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
    selectFolder,
    createInFolder,
    removeThread,
    retrySubscription: () => setSubscriptionAttempt((value) => value + 1),
  };
}
