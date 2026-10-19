import {
  createQuery,
  type QueryClient,
  useQueryClient,
} from "@tanstack/solid-query";
import { type TranslationKey, useI18n } from "shared/i18n";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
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
  reconnectThread,
  releaseFiles,
  renameThread,
  retryQueuedMessage,
  selectFiles as selectFilesCommand,
  selectMedia as selectMediaCommand,
  selectWorkingFolder,
  sendMessage,
  setThreadConfiguration,
  snapshotClipboardImage,
  subscribeThread,
  subscribeThreadList,
} from "../api/threads";
import type {
  Attachment,
  ConnectionFailure,
  MediaKind,
  Thread,
  ThreadConfigurationValue,
  ThreadMetadata,
  ThreadUpdate,
} from "./types";

const threadListQueryKey = ["threads"] as const;
const subscriptionRetryDelay = 5_000;
const maximumSubscriptionRetries = 5;

function sortThreads(entries: ThreadMetadata[]) {
  return entries.toSorted(
    (left, right) =>
      (right.lastPromptAt ?? right.createdAt * 1000) -
        (left.lastPromptAt ?? left.createdAt * 1000) ||
      left.id.localeCompare(right.id),
  );
}

/** Owns synchronization for one thread view; call inside a Solid owner. */
export function createThreadModel(
  queryClient?: QueryClient,
  notifyError: (message: string) => void = () => {},
) {
  const { message: localizedMessage, t, content } = useI18n();
  const client = useQueryClient(queryClient);
  const [state, setState] = createStore<{ thread?: Thread }>({});
  const thread = () => state.thread;
  const [confirmedCompletions, setConfirmedCompletions] = createStore<
    Record<string, string | undefined>
  >({});
  const [subscriptionFailures, setSubscriptionFailures] = createStore<
    Record<string, boolean | undefined>
  >({});
  function confirmCompletion(id: string, turnId: string) {
    if (!deleted.has(id)) setConfirmedCompletions(id, turnId);
  }
  const [selectedThreadId, setSelectedThreadId] = createSignal<string>();
  const [error, setErrorState] = createSignal<string>();
  function setError(message: string | undefined, notify = true) {
    setErrorState(message);
    if (message && notify) notifyError(message);
  }
  const observedErrors = new Set<string>();
  let connectionFailureReceived = false;
  const [configurationError, setConfigurationError] = createSignal<{
    configId: string;
    message: string;
  }>();
  const visibleError = () => error() ?? configurationError()?.message;
  const latestConfigurationAttempts = new Map<string, number>();
  let configurationAttempt = 0;
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
      queryFn: async () => {
        try {
          return (await listThreads()).filter(
            (entry) => !deleted.has(entry.id),
          );
        } catch (cause) {
          notifyError(localizedMessage(cause, "sidebar.loadFailed"));
          throw cause;
        }
      },
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
    }),
    () => client,
  );
  const history = createMemo(() => historyQuery.data ?? []);
  const listLoading = () => historyQuery.isFetching;
  const listError = () => listSubscriptionError() || historyQuery.isError;
  const [listSubscriptionAttempt, setListSubscriptionAttempt] = createSignal(0);
  const reloadList = () => {
    if (listSubscriptionError())
      setListSubscriptionAttempt((attempt) => attempt + 1);
    return historyQuery.refetch();
  };

  function replaceThreadList(entries: ThreadMetadata[]) {
    void client.cancelQueries({ queryKey: threadListQueryKey });
    client.setQueryData(
      threadListQueryKey,
      sortThreads(entries.filter((entry) => !deleted.has(entry.id))),
    );
  }

  createEffect(
    on(listSubscriptionAttempt, () => {
      onCleanup(
        subscribeThreadList(
          (entries) => {
            replaceThreadList(entries);
            setListSubscriptionError(false);
          },
          () => {
            if (!listSubscriptionError()) notifyError(t("sidebar.loadFailed"));
            setListSubscriptionError(true);
          },
        ),
      );
    }),
  );

  const [connectingThreadId, setConnectingThreadId] = createSignal<string>();
  const connecting = () =>
    Boolean(connectingThreadId()) && connectingThreadId() === thread()?.id;
  const [connectFailed, setConnectFailed] = createSignal(false);
  const [drafts, setDrafts] = createStore<
    Record<string, { text: string; command?: string } | undefined>
  >({});
  const [draftAttachmentState, setDraftAttachmentState] = createStore<
    Record<string, Attachment[] | undefined>
  >({});
  const [attachmentErrors, setAttachmentErrors] = createSignal<string[]>([]);
  const draft = () => {
    const id = selectedThreadId();
    return id ? (drafts[id]?.text ?? "") : "";
  };
  const draftCommand = () => {
    const id = selectedThreadId();
    return id ? drafts[id]?.command : undefined;
  };
  const setThreadDraft = (id: string, value: string, command?: string) =>
    setDrafts(id, value ? { text: value, command } : undefined);
  const setDraft = (value: string, command?: string) => {
    const id = selectedThreadId();
    if (id) setThreadDraft(id, value, command);
  };
  const draftAttachments = () => {
    const id = selectedThreadId();
    return id ? (draftAttachmentState[id] ?? []) : [];
  };
  const setThreadAttachments = (id: string, value: Attachment[]) =>
    setDraftAttachmentState(id, value.length ? value : undefined);
  const [sending, setSending] = createSignal(false);
  const [answeringPermissionId, setAnsweringPermissionId] =
    createSignal<string>();
  const [cancellingTurnId, setCancellingTurnId] = createSignal<string>();
  const answerPending = () => Boolean(answeringPermissionId());
  const cancelPending = () => Boolean(cancellingTurnId());
  const activeTurnId = () => thread()?.turns?.at(-1)?.id;
  const streamingTurnId = () =>
    ["running", "waitingForApproval", "cancelling"].includes(
      thread()?.status ?? "",
    )
      ? activeTurnId()
      : undefined;
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
    thread()?.failure !== "authenticationRequired" &&
    actionsEnabled();

  function isNotFound(cause: unknown) {
    return (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "notFound"
    );
  }

  let reconnectAfterSubscription = false;
  function subscriptionFailed(cause?: unknown) {
    setSubscriptionLive(false);
    setSubscriptionError(true);
    const id = selectedThreadId();
    if (id) setSubscriptionFailures(id, true);
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
    const id = selectedThreadId();
    if (id) setSubscriptionFailures(id, undefined);
  }

  function reconcileThread(updatedThread: Thread) {
    setState("thread", reconcile(structuredClone(updatedThread)));
    reconcileDraftMedia(updatedThread);
  }

  function reconcileDraftMedia(
    updatedThread: Pick<Thread, "id" | "status" | "promptCapabilities">,
  ) {
    if (
      !["sessionReady", "running", "waitingForApproval", "cancelling"].includes(
        updatedThread.status,
      )
    )
      return;
    const attachments = draftAttachmentState[updatedThread.id] ?? [];
    const kept = attachments.filter((attachment) => {
      if (attachment.kind !== "image" && attachment.kind !== "audio")
        return true;
      return Boolean(updatedThread.promptCapabilities?.[attachment.kind]);
    });
    if (kept.length === attachments.length) return;
    const keptIds = new Set(kept.map(({ id }) => id));
    setThreadAttachments(updatedThread.id, kept);
    void releaseFiles(
      attachments.filter(({ id }) => !keptIds.has(id)).map(({ id }) => id),
    ).catch(() => undefined);
  }

  function applyThread(updatedThread: Thread) {
    if (deleted.has(updatedThread.id)) return;
    if (selectedThreadId() === updatedThread.id) {
      updateThreadInList(updatedThread);
      reconcileThread(updatedThread);
    }
  }

  function updateThreadInList(updatedThread: ThreadMetadata) {
    if (deleted.has(updatedThread.id)) return;
    const {
      id,
      title,
      workingFolder,
      agentId,
      status,
      sessionId,
      createdAt,
      updatedAt,
      lastPromptAt,
      failure,
      completedTurnId,
      interrupted,
    } = updatedThread;
    const metadata = {
      id,
      title,
      workingFolder,
      agentId,
      status,
      sessionId,
      createdAt,
      updatedAt,
      lastPromptAt,
      failure,
      completedTurnId,
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
    setAttachmentErrors([]);
    setConfigurationError(undefined);
    latestConfigurationAttempts.clear();
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
    reconnectAfterSubscription = false;
    setState("thread", undefined);
    setSelectedThreadId(id);
  }

  function startNewThread() {
    reconnectAfterSubscription = false;
    if (disposed) return;
    selection++;
    view++;
    clearSubscriptionRetry();
    subscriptionRetries = 0;
    setSelectedThreadId(undefined);
    setState("thread", undefined);
    setError(undefined);
    setAttachmentErrors([]);
    setConfigurationError(undefined);
    latestConfigurationAttempts.clear();
    setSending(false);
    setAnsweringPermissionId(undefined);
    setCancellingTurnId(undefined);
    setConnectingThreadId(undefined);
    setConnectFailed(false);
    setSubscriptionError(false);
    setSubscriptionLive(false);
    setRetryExhausted(false);
  }

  function applyUpdate(update: ThreadUpdate) {
    if (update.kind === "thread") {
      const firstSnapshot = !thread();
      applyThread(update.thread);
      if (update.thread.id === selectedThreadId()) {
        subscriptionReady();
        if (reconnectAfterSubscription) {
          reconnectAfterSubscription = false;
          if (["disconnected", "failed"].includes(update.thread.status))
            void connect();
          return;
        }
      }
      if (
        firstSnapshot &&
        update.thread.id === selectedThreadId() &&
        (update.thread.status === "disconnected" ||
          (update.thread.status === "failed" &&
            update.thread.lastPromptAt === null))
      )
        void connect();
      return;
    }
    const current = thread();
    if (!subscriptionLive() || !current) return;
    if (update.kind === "patch") {
      if (update.thread.id !== current.id) return;
      for (const error of update.errors ?? []) {
        if (observedErrors.has(error.id)) continue;
        observedErrors.add(error.id);
        if (error.failure) {
          const persistent = error.failure === update.thread.failure;
          if (!persistent) notifyError(t(failureKeys[error.failure]));
          if (connecting()) connectionFailureReceived = true;
        } else if (error.message) {
          if (error.message !== update.thread.storageError)
            notifyError(content(error.message) ?? error.message);
        }
      }
      updateThreadInList(update.thread);
      setState(
        "thread",
        reconcile({ ...structuredClone(update.thread), turns: current.turns }),
      );
      reconcileDraftMedia(update.thread);
      for (const turnUpdate of update.turnUpdates) {
        if (turnUpdate.kind === "replaced") {
          setState(
            "thread",
            "turns",
            reconcile(structuredClone(turnUpdate.turns)),
          );
          continue;
        }
        if (turnUpdate.kind === "added") {
          if (thread()?.turns.some((turn) => turn.id === turnUpdate.turn.id)) {
            subscriptionFailed();
            return;
          }
          setState(
            "thread",
            "turns",
            thread()?.turns.length ?? 0,
            structuredClone(turnUpdate.turn),
          );
          continue;
        }
        const turnIndex = thread()?.turns.findIndex(
          (turn) => turn.id === turnUpdate.turnId,
        );
        if (turnIndex === undefined || turnIndex < 0) {
          subscriptionFailed();
          return;
        }
        setState(
          "thread",
          "turns",
          turnIndex,
          "stopReason",
          turnUpdate.stopReason,
        );
      }
      return;
    }
    if (update.threadId !== current.id) return;
    const turnIndex =
      update.kind === "planContentUpdate"
        ? current.turns.findIndex((turn) => turn.id === update.turnId)
        : current.turns.length - 1;
    if (turnIndex < 0 || current.turns[turnIndex]?.id !== update.turnId) {
      subscriptionFailed();
      return;
    }
    const parts = current.turns[turnIndex].responseParts;
    if (
      update.kind === "toolUpdate" ||
      update.kind === "planUpdate" ||
      update.kind === "planContentUpdate"
    ) {
      const index = parts.findIndex(
        (part) => part.kind === update.part.kind && part.id === update.part.id,
      );
      if (index < 0)
        setState(
          "thread",
          "turns",
          turnIndex,
          "responseParts",
          parts.length,
          structuredClone(update.part),
        );
      else
        setState(
          "thread",
          "turns",
          turnIndex,
          "responseParts",
          index,
          reconcile(structuredClone(update.part)),
        );
      return;
    }
    const kind = update.kind === "thoughtDelta" ? "thought" : "text";
    const index = parts.findIndex(
      (part) => part.kind === kind && part.id === update.partId,
    );
    if (index < 0) {
      setState("thread", "turns", turnIndex, "responseParts", parts.length, {
        kind,
        id: update.partId,
        text: update.text,
      });
    } else {
      setState("thread", "turns", turnIndex, "responseParts", index, (part) =>
        part.kind === kind ? { ...part, text: part.text + update.text } : part,
      );
    }
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
    const attachments = draftAttachments().map((attachment) => ({
      ...attachment,
    }));
    if (!current || !canSend() || (!message.trim() && !attachments.length))
      return;
    setSending(true);
    setError(undefined);
    try {
      await sendMessage(current.id, { text: message, attachments });
      if (drafts[current.id]?.text === message) setThreadDraft(current.id, "");
      if (
        draftAttachmentState[current.id]?.length === attachments.length &&
        draftAttachmentState[current.id]?.every(
          (attachment, index) => attachment.id === attachments[index]?.id,
        )
      )
        setThreadAttachments(current.id, []);
      if (isCurrent(expectedView)) setAttachmentErrors([]);
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(localizedMessage(cause, "thread.error.send"));
    } finally {
      if (isCurrent(expectedView)) setSending(false);
    }
  }

  async function selectFiles() {
    const expectedView = view;
    const current = thread();
    if (!current || !canSend()) return;
    setAttachmentErrors([]);
    try {
      const selection = await selectFilesCommand(
        current.id,
        t("thread.fileDialogTitle"),
      );
      if (!isCurrent(expectedView)) {
        void releaseFiles(selection.attachments.map(({ id }) => id)).catch(
          () => undefined,
        );
        return;
      }
      setThreadAttachments(current.id, [
        ...draftAttachments(),
        ...selection.attachments,
      ]);
      setAttachmentErrors(selection.errors.map(({ name }) => name));
      for (const { name } of selection.errors)
        notifyError(t("thread.fileUnavailable", { name }));
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(localizedMessage(cause, "thread.error.selectFiles"));
    }
  }

  async function selectMedia(kind: MediaKind) {
    const expectedView = view;
    const current = thread();
    if (!current || !canSend() || !current.promptCapabilities?.[kind]) return;
    setAttachmentErrors([]);
    try {
      const selection = await selectMediaCommand(
        current.id,
        kind,
        kind === "image"
          ? t("thread.imageDialogTitle")
          : t("thread.audioDialogTitle"),
      );
      if (!isCurrent(expectedView)) {
        void releaseFiles(selection.attachments.map(({ id }) => id)).catch(
          () => undefined,
        );
        return;
      }
      if (!thread()?.promptCapabilities?.[kind]) {
        void releaseFiles(selection.attachments.map(({ id }) => id)).catch(
          () => undefined,
        );
        return;
      }
      setThreadAttachments(current.id, [
        ...draftAttachments(),
        ...selection.attachments,
      ]);
      setAttachmentErrors(selection.errors.map(({ name }) => name));
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(localizedMessage(cause, "thread.error.selectMedia"));
    }
  }

  async function pasteImage(image: File) {
    const expectedView = view;
    const current = thread();
    if (!current || !canSend()) return;
    if (!current.promptCapabilities?.image) {
      setError(t("thread.imagePasteUnsupported"));
      return;
    }
    setAttachmentErrors([]);
    try {
      const bytes = Array.from(new Uint8Array(await image.arrayBuffer()));
      const extension =
        image.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      const selection = await snapshotClipboardImage(
        current.id,
        image.name || `pasted-image.${extension}`,
        image.type,
        bytes,
      );
      if (!isCurrent(expectedView)) {
        void releaseFiles(selection.attachments.map(({ id }) => id)).catch(
          () => undefined,
        );
        return;
      }
      if (!thread()?.promptCapabilities?.image) {
        void releaseFiles(selection.attachments.map(({ id }) => id)).catch(
          () => undefined,
        );
        return;
      }
      setThreadAttachments(current.id, [
        ...draftAttachments(),
        ...selection.attachments,
      ]);
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(localizedMessage(cause, "thread.error.selectMedia"));
    }
  }

  function rejectClipboardImage() {
    setError(t("thread.imagePasteUnsupported"));
  }

  function removeAttachment(id: string) {
    const current = thread();
    if (!current) return;
    setThreadAttachments(
      current.id,
      draftAttachments().filter((attachment) => attachment.id !== id),
    );
    void releaseFiles([id]).catch(() => undefined);
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

  async function retryQueued(id: string) {
    const expectedView = view;
    const current = thread();
    if (!current || !actionsEnabled()) return;
    try {
      await retryQueuedMessage(current.id, id);
    } catch (cause) {
      if (isCurrent(expectedView))
        setError(localizedMessage(cause, "thread.error.retryQueued"));
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

  async function configure(configId: string, value: ThreadConfigurationValue) {
    const expectedView = view;
    const current = thread();
    if (!current || !actionsEnabled()) return;
    const attempt = ++configurationAttempt;
    latestConfigurationAttempts.set(configId, attempt);
    try {
      await setThreadConfiguration(current.id, configId, value);
      if (
        isCurrent(expectedView) &&
        latestConfigurationAttempts.get(configId) === attempt &&
        configurationError()?.configId === configId
      )
        setConfigurationError(undefined);
    } catch (cause) {
      if (
        isCurrent(expectedView) &&
        latestConfigurationAttempts.get(configId) === attempt
      ) {
        const message = localizedMessage(cause, "thread.error.configure");
        setConfigurationError({ configId, message });
        notifyError(message);
      }
    }
  }

  const canReconnect = () =>
    !connecting() &&
    (!thread() ||
      ["sessionReady", "disconnected", "failed"].includes(
        thread()?.status ?? "",
      )) &&
    (retryExhausted() || actionsEnabled());

  async function reconnect() {
    if (!canReconnect()) return;
    if (!actionsEnabled()) {
      reconnectAfterSubscription = true;
      retrySubscription();
      return;
    }
    await connect(true);
  }

  async function connect(manual = false) {
    const expectedView = view;
    const current = thread();
    if (!current || !actionsEnabled() || connecting()) return;
    connectionFailureReceived = false;
    setConnectingThreadId(current.id);
    setConnectFailed(false);
    setError(undefined);
    setConfigurationError(undefined);
    latestConfigurationAttempts.clear();
    try {
      if (manual) await reconnectThread(current.id);
      else await connectThread(current.id);
    } catch (cause) {
      if (isCurrent(expectedView)) {
        setConnectFailed(true);
        setError(
          localizedMessage(cause, "thread.error.connect"),
          !connectionFailureReceived,
        );
      }
    } finally {
      if (isCurrent(expectedView)) setConnectingThreadId(undefined);
    }
  }

  async function selectFolder() {
    if (selecting()) return;
    setSelecting(true);
    setError(undefined);
    const attempt = ++selection;
    try {
      const folder = await selectWorkingFolder(t("thread.folderDialogTitle"));
      if (!disposed && attempt === selection) return folder;
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
    const attachments = (draftAttachmentState[id] ?? []).map(({ id }) => id);
    await deleteThreadCommand(id);
    if (attachments.length)
      void releaseFiles(attachments).catch(() => undefined);
    deleted.add(id);
    setConfirmedCompletions(id, undefined);
    setSubscriptionFailures(id, undefined);
    setThreadDraft(id, "");
    setThreadAttachments(id, []);
    void client.cancelQueries({ queryKey: threadListQueryKey });
    client.setQueryData<ThreadMetadata[]>(threadListQueryKey, (previous) =>
      (previous ?? []).filter((entry) => entry.id !== id),
    );
    if (selectedThreadId() !== id) return;
    startNewThread();
  }

  function retrySubscription() {
    clearSubscriptionRetry();
    subscriptionRetries = 0;
    setSubscriptionError(false);
    setRetryExhausted(false);
    setSubscriptionLive(false);
    setSubscriptionAttempt((value) => value + 1);
  }

  return {
    thread,
    selectedThreadId,
    error: visibleError,
    selecting,
    history,
    confirmCompletion,
    confirmedCompletion: (id: string) => confirmedCompletions[id],
    subscriptionFailedFor: (id: string) => Boolean(subscriptionFailures[id]),
    listLoading,
    listError,
    reloadList,
    connecting,
    connectFailed,
    draft,
    draftCommand,
    setDraft,
    draftAttachments,
    attachmentErrors,
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
    startNewThread,
    openThread,
    send,
    selectFiles,
    selectMedia,
    pasteImage,
    rejectClipboardImage,
    removeAttachment,
    deleteQueued,
    retryQueued,
    answer,
    cancel,
    configure,
    connect,
    selectFolder,
    createInFolder,
    removeThread,
    renameThread,
    retrySubscription,
    reconnect,
    canReconnect,
  };
}

export type ThreadModel = ReturnType<typeof createThreadModel>;

export const failureKeys: Record<ConnectionFailure, TranslationKey> = {
  executableNotFound: "thread.failure.executableNotFound",
  launchFailed: "thread.failure.launchFailed",
  initializationFailed: "thread.failure.initializationFailed",
  sessionCreationFailed: "thread.failure.sessionCreationFailed",
  authenticationRequired: "thread.failure.authenticationRequired",
  processExited: "thread.failure.processExited",
  connectionClosed: "thread.failure.connectionClosed",
  timedOut: "thread.failure.timedOut",
  agentRemoved: "thread.failure.agentRemoved",
  resumptionUnsupported: "thread.failure.resumptionUnsupported",
  sessionRestorationFailed: "thread.failure.sessionRestorationFailed",
};
