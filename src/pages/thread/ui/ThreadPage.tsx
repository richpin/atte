import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { useAgentAuthentication } from "features/agent-authentication";
import { useI18n } from "shared/i18n";
import { showErrorToast } from "shared/ui";
import { createEffect, createSignal, Show, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import type { ThreadModel } from "../model/thread";
import type { PreparedAgent } from "../model/types";
import { Message } from "./Message";
import { ThreadComposer } from "./ThreadComposer";
import { ThreadInfoCard } from "./ThreadInfoCard";
import { ThreadTimeline } from "./ThreadTimeline";

const composerBottomOffset = 16;
const timelineComposerGap = 48;

export function ThreadPage(props: {
  active: boolean;
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
  let previousSelectedThreadId: string | undefined;

  async function authenticateThread(method: string) {
    const origin = thread();
    if (!origin) return;
    const succeeded = await authentication.login(
      origin.agentId,
      method,
      showErrorToast,
    );
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
        void authentication.requireAuthentication(
          current.agentId,
          showErrorToast,
        );
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
    if (state.status === "idle")
      void authentication.discover(current.agentId, showErrorToast);
  });

  const loading = () =>
    Boolean(selectedThreadId()) &&
    (!thread() || connecting() || thread()?.status === "connecting");

  return (
    <main class="@container/thread flex h-full min-h-0 flex-col overflow-hidden bg-canvas text-ink">
      <Show when={selectedThreadId()}>
        <div class="relative min-h-0 flex-1">
          <div hidden={loading()} class="h-full">
            <ThreadTimeline
              followKey={`${thread()?.id}:${activeTurnId()}`}
              bottomInset={composerInset()}
            >
              <Show
                when={
                  thread() &&
                  (["agentRemoved", "executableNotFound"].includes(
                    thread()?.failure ?? "",
                  ) ||
                    !props.agents.some(
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
              <Message
                turns={thread()?.turns ?? []}
                streamingTurnId={
                  !props.model.subscriptionError()
                    ? streamingTurnId()
                    : undefined
                }
                thinkingTurnId={
                  !props.model.subscriptionError() &&
                  !thread()?.failure &&
                  !thread()?.requestFailure &&
                  thread()?.status === "running"
                    ? activeTurnId()
                    : undefined
                }
                agentId={thread()?.agentId}
                permissionToolIds={thread()?.permissions.map(
                  (request) => request.toolCallId,
                )}
                interrupted={thread()?.interrupted}
                approvalPending={thread()?.status === "waitingForApproval"}
                waitingTurnId={
                  !props.model.subscriptionError() &&
                  !thread()?.failure &&
                  !thread()?.requestFailure &&
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
              (!thread()?.turns?.length && thread()?.status === "sessionReady")
            }
          >
            <div
              class="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center px-6"
              style={{ bottom: `${composerHeight() + composerBottomOffset}px` }}
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
          <Show when={thread()}>
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
                  authentication={authentication.state(currentThread().agentId)}
                  onRetryAuthentication={() =>
                    void authentication.discover(
                      currentThread().agentId,
                      showErrorToast,
                    )
                  }
                  onAuthenticate={(method) => void authenticateThread(method)}
                  onCancelAuthentication={() =>
                    void authentication.cancel(currentThread().agentId)
                  }
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
    </main>
  );
}
