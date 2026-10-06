import { makeResizeObserver } from "@solid-primitives/resize-observer";
import {
  SignInDialog,
  useAgentAuthentication,
} from "features/agent-authentication";
import { useI18n } from "shared/i18n";
import { createEffect, createSignal, Show, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import type { ThreadModel } from "../model/thread";
import type { PreparedAgent } from "../model/types";
import { Message } from "./Message";
import { ThreadComposer } from "./ThreadComposer";
import { ThreadErrors } from "./ThreadErrors";
import { ThreadInfoCard } from "./ThreadInfoCard";
import { ThreadTimeline } from "./ThreadTimeline";

const composerBottomOffset = 16;
const timelineComposerGap = 48;

export function ThreadPage(props: {
  active: boolean;
  showInfoCard: boolean;
  model: ThreadModel;
  agents: PreparedAgent[];
  onManage: () => void;
}) {
  const { t } = useI18n();
  const authentication = useAgentAuthentication();
  const model = props.model;
  const {
    thread,
    selectedThreadId,
    connecting,
    draft,
    draftAttachments,
    attachmentErrors,
    setDraft,
    answerPending,
    cancelPending,
    activeTurnId,
    streamingTurnId,
    showStop,
    stopping,
    actionsEnabled,
    canSend,
    send,
    selectFiles,
    selectMedia,
    pasteImage,
    rejectClipboardImage,
    removeAttachment,
    deleteQueued,
    answer,
    cancel,
    configure,
    connect,
    retryQueued,
  } = model;
  const [composerHeight, setComposerHeight] = createSignal(0);
  let composerOverlay: HTMLDivElement | undefined;
  const { observe: observeComposer } = makeResizeObserver((entries) => {
    const entry = entries.find(({ target }) => target === composerOverlay);
    if (entry) setComposerHeight(entry.contentRect.height);
  });
  const composerInset = () =>
    composerHeight() + composerBottomOffset + timelineComposerGap;
  const [authenticationReconnect, setAuthenticationReconnect] = createStore({
    attemptedByThread: {} as Record<string, number | undefined>,
    blockedByThread: {} as Record<string, number | undefined>,
    completedByAgent: {} as Record<string, number | undefined>,
  });
  const [signInThread, setSignInThread] = createSignal<string>();
  let promptInput: HTMLTextAreaElement | undefined;
  let returnToPrompt = false;
  let dialogOrigin: string | undefined;
  const signInOpen = () =>
    props.active &&
    signInThread() === selectedThreadId() &&
    Boolean(signInThread());

  createEffect(() => {
    const current = thread();
    if (!props.active || signInThread() !== selectedThreadId())
      setSignInThread(undefined);
    if (props.active && current?.failure === "authenticationRequired") {
      dialogOrigin = current.id;
      returnToPrompt = false;
      setSignInThread(current.id);
    }
  });

  createEffect(() => {
    const current = thread();
    if (
      !signInOpen() ||
      !current ||
      current.status !== "sessionReady" ||
      current.failure
    )
      return;
    if (authentication.state(current.agentId).status !== "authenticated")
      return;
    returnToPrompt = true;
    setSignInThread(undefined);
  });

  const reconnectingThreads = new Set<string>();
  let previousSelectedThreadId: string | undefined;

  async function authenticateThread(method: string) {
    const origin = thread();
    if (!origin) return;
    const succeeded = await authentication.login(origin.agentId, method);
    if (!succeeded) return;
    const state = authentication.state(origin.agentId);
    if (state.status !== "authenticated") return;
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
    setAuthenticationReconnect(
      "completedByAgent",
      origin.agentId,
      state.generation,
    );
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
    if (
      current?.status === "connecting" &&
      authenticationReconnect.attemptedByThread[current.id] !== undefined
    )
      reconnectingThreads.add(current.id);
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
        if (!connecting() && reconnectingThreads.has(current.id))
          void authentication.requireAuthentication(current.agentId);
        return;
      }
      reconnectingThreads.delete(current.id);
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

  const loading = () =>
    Boolean(selectedThreadId()) &&
    (!thread() || connecting() || thread()?.status === "connecting");

  return (
    <main class="relative flex h-full min-h-0 flex-col overflow-hidden bg-canvas text-ink">
      <div inert={signInOpen()} class="flex h-full min-h-0 flex-col">
        <Show when={selectedThreadId()}>
          <Show when={!signInOpen()}>
            <ThreadErrors
              thread={thread()}
              subscriptionFailed={model.subscriptionError()}
              canReconnect={model.canReconnect()}
              onReconnect={() => void model.reconnect()}
              onManage={props.onManage}
            />
          </Show>
          <div class="relative min-h-0 flex-1">
            <div hidden={loading()} class="h-full">
              <ThreadTimeline
                followKey={`${thread()?.id}:${activeTurnId()}`}
                bottomInset={composerInset()}
              >
                <Show
                  when={
                    thread() &&
                    !["agentRemoved", "executableNotFound"].includes(
                      thread()?.failure ?? "",
                    ) &&
                    !props.agents.some(
                      (agent) => agent.id === thread()?.agentId,
                    )
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
                <Message
                  turns={thread()?.turns ?? []}
                  streamingTurnId={
                    !model.subscriptionError() ? streamingTurnId() : undefined
                  }
                  thinkingTurnId={
                    !model.subscriptionError() &&
                    !thread()?.failure &&
                    thread()?.status === "running"
                      ? activeTurnId()
                      : undefined
                  }
                  permissionToolIds={thread()?.permissions.map(
                    (request) => request.toolCallId,
                  )}
                  interrupted={thread()?.interrupted}
                  agentId={thread()?.agentId}
                  approvalPending={thread()?.status === "waitingForApproval"}
                  respondingTurnId={
                    !props.model.subscriptionError() &&
                    !thread()?.failure &&
                    ["running", "waitingForApproval"].includes(
                      thread()?.status ?? "",
                    )
                      ? activeTurnId()
                      : undefined
                  }
                />
              </ThreadTimeline>
            </div>
            <Show
              when={
                loading() ||
                (!thread()?.turns?.length &&
                  thread()?.status === "sessionReady")
              }
            >
              <div
                class="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center px-6"
                style={{
                  bottom: `${composerHeight() + composerBottomOffset}px`,
                }}
              >
                <h2 class="text-center text-3xl font-medium tracking-tight text-muted">
                  {loading()
                    ? t("thread.loading")
                    : t("thread.waitingForFirstMessage")}
                  <span
                    aria-hidden="true"
                    class="inline-block font-mono tracking-normal motion-safe:animate-waiting-ellipsis"
                  >
                    ...
                  </span>
                </h2>
              </div>
            </Show>
            <Show when={thread() && props.showInfoCard}>
              <ThreadInfoCard usage={thread()?.contextUsage ?? null} />
            </Show>
            <div
              ref={(element) => {
                composerOverlay = element;
                observeComposer(element);
                setComposerHeight(element.getBoundingClientRect().height);
              }}
              class="absolute inset-x-0 bottom-4"
            >
              <Show when={thread()}>
                {(currentThread) => (
                  <ThreadComposer
                    active={props.active}
                    thread={currentThread()}
                    draft={draft()}
                    draftAttachments={draftAttachments()}
                    attachmentErrors={attachmentErrors()}
                    answerPending={answerPending()}
                    cancelPending={cancelPending()}
                    showStop={showStop()}
                    stopping={stopping()}
                    actionsEnabled={actionsEnabled()}
                    canSend={canSend()}
                    signInOpen={signInOpen()}
                    promptRef={(element) => {
                      promptInput = element;
                    }}
                    onDraftChange={setDraft}
                    onSelectFiles={() => void selectFiles()}
                    onSelectMedia={(kind) => void selectMedia(kind)}
                    onPasteImage={(image) => void pasteImage(image)}
                    onUnsupportedImagePaste={rejectClipboardImage}
                    onRemoveAttachment={removeAttachment}
                    onSend={() => void send()}
                    onCancel={() => void cancel()}
                    onAnswer={answer}
                    onConfigure={(configId, value) =>
                      void configure(configId, value)
                    }
                    onDeleteQueued={deleteQueued}
                    onRetryQueued={retryQueued}
                  />
                )}
              </Show>
            </div>
          </div>
        </Show>
      </div>
      <Show when={thread()}>
        {(current) => (
          <SignInDialog
            open={signInOpen()}
            agentId={current().agentId}
            agentName={
              props.agents.find((agent) => agent.id === current().agentId)
                ?.name ?? current().agentId
            }
            state={authentication.state(current().agentId)}
            reconnectFailed={
              !connecting() &&
              (authenticationReconnect.blockedByThread[current().id] !==
                undefined ||
                props.model.connectFailed() ||
                (current().status === "failed" &&
                  current().failure !== "authenticationRequired"))
            }
            onReconnect={() => void props.model.reconnect()}
            onClosed={() => {
              if (!props.active || selectedThreadId() !== dialogOrigin) return;
              if (returnToPrompt) promptInput?.focus();
            }}
            onRetry={() => void authentication.discover(current().agentId)}
            onSelect={(method) => void authenticateThread(method)}
            onCancel={() => void authentication.cancel(current().agentId)}
          />
        )}
      </Show>
    </main>
  );
}
