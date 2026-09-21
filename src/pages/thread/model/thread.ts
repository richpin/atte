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
import { createStore, reconcile } from "solid-js/store";
import {
  answerPermission,
  cancelTurn,
  connectThread,
  createThread,
  deleteQueuedMessage,
  deleteThread as deleteThreadCommand,
  listThreads,
  selectWorkingFolder,
  sendMessage,
  subscribeThread,
  subscribeThreadList,
} from "../api/threads";
import type { Thread, ThreadMetadata, ThreadUpdate } from "./types";

const threadListQueryKey = ["threads"] as const;
const subscriptionRetryDelay = 5_000;
const maximumSubscriptionRetries = 5;

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
  const [state, setState] = createStore<{ thread?: Thread }>({});
  const thread = () => state.thread;
  const [selectedThreadId, setSelectedThreadId] = createSignal<string>();
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

  const [connectingThreadId, setConnectingThreadId] = createSignal<string>();
  const connecting = () =>
    Boolean(connectingThreadId()) && connectingThreadId() === thread()?.id;
  const [connectFailed, setConnectFailed] = createSignal(false);
  const [drafts, setDrafts] = createStore<Record<string, string | undefined>>(
    {},
  );
  const draft = () => {
    const id = selectedThreadId();
    return id ? (drafts[id] ?? "") : "";
  };
  const setThreadDraft = (id: string, value: string) =>
    setDrafts(id, value || undefined);
  const setDraft = (value: string) => {
    const id = selectedThreadId();
    if (id) setThreadDraft(id, value);
  };
  const [sending, setSending] = createSignal(false);
  const [answeringPermissionId, setAnsweringPermissionId] =
    createSignal<string>();
  const [cancellingTurnId, setCancellingTurnId] = createSignal<string>();
  const answerPending = () => Boolean(answeringPermissionId());
  const cancelPending = () => Boolean(cancellingTurnId());
  const activeTurnId = () => thread()?.turns?.at(-1)?.id;
  const canCancel = () =>
    ["running", "waitingForApproval"].includes(thread()?.status ?? "");
  const showStop = () => canCancel() || thread()?.status === "cancelling";
  const stopping = () => cancelPending() || thread()?.status === "cancelling";
  const [subscriptionError, setSubscriptionError] = createSignal(false);
  const [subscriptionLive, setSubscriptionLive] = createSignal(false);
  const [retryExhausted, setRetryExhausted] = createSignal(false);
  const [subscriptionAttempt, setSubscriptionAttempt] = createSignal(0);
  let subscriptionRetries = 0;
  let subscriptionRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const clearSubscriptionRetry = () => {
    if (subscriptionRetryTimer !== undefined)
      clearTimeout(subscriptionRetryTimer);
    subscriptionRetryTimer = undefined;
  };
  onCleanup(clearSubscriptionRetry);
  const actionsEnabled = () => subscriptionLive();
  const canSend = () =>
    ["sessionReady", "running", "cancelling"].includes(
      thread()?.status ?? "",
    ) &&
    !sending() &&
    actionsEnabled();

  function isNotFound(cause: unknown) {
    return (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "notFound"
    );
  }

  function subscriptionFailed(cause?: unknown) {
    setSubscriptionLive(false);
    setSubscriptionError(true);
    if (isNotFound(cause)) {
      clearSubscriptionRetry();
      setSubscriptionError(false);
      setRetryExhausted(false);
      setSelectedThreadId(undefined);
      setState("thread", undefined);
      setError(localizedMessage(cause, "thread.error.open"));
      return;
    }
    if (subscriptionRetries >= maximumSubscriptionRetries) {
      setRetryExhausted(true);
      return;
    }
    subscriptionRetries++;
    clearSubscriptionRetry();
    subscriptionRetryTimer = setTimeout(() => {
      subscriptionRetryTimer = undefined;
      if (!disposed && selectedThreadId())
        setSubscriptionAttempt((value) => value + 1);
    }, subscriptionRetryDelay);
  }

  function subscriptionReady() {
    clearSubscriptionRetry();
    subscriptionRetries = 0;
    setSubscriptionError(false);
    setRetryExhausted(false);
    setSubscriptionLive(true);
  }

  function reconcileThread(updatedThread: Thread) {
    setState("thread", reconcile(structuredClone(updatedThread)));
  }

  function applyThread(updatedThread: Thread) {
    if (deleted.has(updatedThread.id)) return;
    if (selectedThreadId() === updatedThread.id) {
      updateThreadInList(updatedThread);
      reconcileThread(updatedThread);
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

  async function openThread(id: string) {
    if (selectedThreadId() === id || disposed) return;
    selection++;
    view++;
    setError(undefined);
    setSending(false);
    setAnsweringPermissionId(undefined);
    setCancellingTurnId(undefined);
    setConnectingThreadId(undefined);
    setConnectFailed(false);
    clearSubscriptionRetry();
    subscriptionRetries = 0;
    setSubscriptionError(false);
    setRetryExhausted(false);
    setSubscriptionLive(false);
    setState("thread", undefined);
    setSelectedThreadId(id);
  }

  function applyUpdate(update: ThreadUpdate) {
    if (update.kind === "thread") {
      const firstSnapshot = !thread();
      applyThread(update.thread);
      if (update.thread.id === selectedThreadId()) subscriptionReady();
      if (
        firstSnapshot &&
        update.thread.id === selectedThreadId() &&
        update.thread.status === "disconnected"
      )
        void connect();
      return;
    }
    const current = thread();
    if (!subscriptionLive() || !current || update.threadId !== current.id)
      return;
    if (current.turns.at(-1)?.id !== update.turnId) {
      subscriptionFailed();
      return;
    }
    const turnIndex = current.turns.length - 1;
    setState(
      "thread",
      "turns",
      turnIndex,
      "response",
      (response) => response + update.text,
    );
  }

  createEffect(
    on(
      () => [selectedThreadId(), subscriptionAttempt()] as const,
      ([id]) => {
        if (!id) return;
        setSubscriptionLive(false);
        onCleanup(subscribeThread(id, applyUpdate, subscriptionFailed));
      },
    ),
  );

  async function send() {
    const expectedView = view;
    const current = thread();
    const message = draft();
    if (!current || !canSend() || !message.trim()) return;
    setSending(true);
    setError(undefined);
    try {
      await sendMessage(current.id, message);
      if (drafts[current.id] === message) setThreadDraft(current.id, "");
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
    if (!current || !actionsEnabled()) return;
    try {
      await deleteQueuedMessage(current.id, id);
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(localizedMessage(cause, "thread.error.deleteQueued"));
    }
  }

  async function answer(request: string, option: string) {
    const expectedView = view;
    const current = thread();
    if (
      !current ||
      !actionsEnabled() ||
      answeringPermissionId() ||
      cancellingTurnId()
    )
      return;
    setAnsweringPermissionId(request);
    setError(undefined);
    try {
      await answerPermission(current.id, request, option);
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(localizedMessage(cause, "thread.error.answerPermission"));
    } finally {
      if (isCurrent(expectedView)) setAnsweringPermissionId(undefined);
    }
  }

  async function cancel() {
    const expectedView = view;
    const current = thread();
    const turn = activeTurnId();
    if (
      !current ||
      !actionsEnabled() ||
      !turn ||
      !canCancel() ||
      cancellingTurnId()
    )
      return;
    setCancellingTurnId(turn);
    setError(undefined);
    try {
      await cancelTurn(current.id, turn);
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(localizedMessage(cause, "thread.error.cancel"));
    } finally {
      if (isCurrent(expectedView)) setCancellingTurnId(undefined);
    }
  }

  async function connect() {
    const expectedView = view;
    const current = thread();
    if (!current || !actionsEnabled() || connecting()) return;
    setConnectingThreadId(current.id);
    setConnectFailed(false);
    setError(undefined);
    try {
      await connectThread(current.id);
    } catch (cause) {
      if (isCurrent(expectedView)) {
        setConnectFailed(true);
        setError(localizedMessage(cause, "thread.error.connect"));
      }
    } finally {
      if (isCurrent(expectedView)) setConnectingThreadId(undefined);
    }
  }

  async function selectFolder(agentId: string) {
    if (selecting()) return;
    setSelecting(true);
    setError(undefined);
    const attempt = ++selection;
    try {
      const id = await selectWorkingFolder(
        agentId,
        t("thread.folderDialogTitle"),
      );
      if (id) {
        if (disposed) return;
        if (attempt === selection) await openThread(id);
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
      const id = await createThread(folder, agentId);
      if (disposed) return;
      if (attempt !== selection) return;
      await openThread(id);
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
    setThreadDraft(id, "");
    void client.cancelQueries({ queryKey: threadListQueryKey });
    client.setQueryData<ThreadMetadata[]>(threadListQueryKey, (previous) =>
      (previous ?? []).filter((entry) => entry.id !== id),
    );
    if (selectedThreadId() !== id) return;
    selection++;
    view++;
    clearSubscriptionRetry();
    subscriptionRetries = 0;
    setSelectedThreadId(undefined);
    setState("thread", undefined);
    setError(undefined);
    setSending(false);
    setAnsweringPermissionId(undefined);
    setCancellingTurnId(undefined);
    setConnectingThreadId(undefined);
    setConnectFailed(false);
    setSubscriptionError(false);
    setSubscriptionLive(false);
    setRetryExhausted(false);
  }

  return {
    thread,
    selectedThreadId,
    error,
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
    connect,
    selectFolder,
    createInFolder,
    removeThread,
    retrySubscription: () => {
      clearSubscriptionRetry();
      subscriptionRetries = 0;
      setSubscriptionError(false);
      setRetryExhausted(false);
      setSubscriptionLive(false);
      setSubscriptionAttempt((value) => value + 1);
    },
  };
}
