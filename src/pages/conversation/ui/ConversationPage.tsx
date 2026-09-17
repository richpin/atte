import {
  createEffect,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import {
  connectConversation,
  preparedAgents,
  selectWorkingFolder,
  sendMessage,
  subscribeConversation,
} from "../api/conversations";
import {
  type Conversation,
  failureMessages,
  statusLabels,
} from "../model/types";
import { Transcript } from "./Transcript";

export function ConversationPage() {
  const [conversation, setConversation] = createSignal<Conversation>();
  const [error, setError] = createSignal<string>();
  const [selecting, setSelecting] = createSignal(false);

  const [agents] = createResource(async () => {
    try {
      return await preparedAgents();
    } catch {
      setError("준비된 에이전트를 불러올 수 없습니다.");
      return [];
    }
  });
  const [selectedAgent, setSelectedAgent] = createSignal("");
  const agentId = () => selectedAgent() || agents()?.[0]?.id || "";
  const [connecting, setConnecting] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [streamError, setStreamError] = createSignal(false);
  const [subscriptionAttempt, setSubscriptionAttempt] = createSignal(0);
  const canSend = () =>
    conversation()?.status === "sessionReady" && !sending() && !streamError();

  function applySnapshot(snapshot: Conversation) {
    const current = conversation();
    if (current?.id === snapshot.id && snapshot.revision >= current.revision)
      setConversation(snapshot);
  }

  createEffect(
    on(
      () => [conversation()?.id, subscriptionAttempt()] as const,
      ([id]) => {
        if (!id) return;
        setStreamError(false);
        onCleanup(
          subscribeConversation(id, applySnapshot, () => setStreamError(true)),
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
      const snapshot = await sendMessage(current.id, message());
      if (conversation()?.id === current.id) {
        applySnapshot(snapshot);
        setMessage("");
      }
    } catch (cause) {
      if (conversation()?.id === current.id)
        setError(errorMessage(cause, "메시지를 전송할 수 없습니다."));
    } finally {
      setSending(false);
    }
  }

  async function connect() {
    const draft = conversation();
    if (!draft || connecting()) return;
    setConnecting(true);
    setError(undefined);
    try {
      const snapshot = await connectConversation(draft.id);
      if (conversation()?.id === draft.id) applySnapshot(snapshot);
    } catch (cause) {
      setError(
        errorMessage(cause, "연결을 시작할 수 없습니다. 다시 시도해주세요."),
      );
    } finally {
      setConnecting(false);
    }
  }

  async function selectFolder() {
    if (selecting()) return;
    setSelecting(true);
    setError(undefined);
    try {
      const draft = await selectWorkingFolder(agentId());
      if (draft) {
        setConversation(draft);
        setMessage("");
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

  return (
    <main class="flex min-h-dvh flex-col bg-canvas text-ink">
      <header class="flex h-14 shrink-0 items-center gap-4 border-b border-line px-6">
        <span class="font-semibold tracking-tight">atte</span>
        <Show when={conversation()}>
          {(draft) => (
            <>
              <h1 class="shrink-0 text-sm font-medium">새 대화</h1>
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
          disabled={selecting() || agents.loading || !agentId() || connecting()}
          onClick={selectFolder}
        >
          {selecting() ? "선택 중…" : "폴더 선택"}
        </button>
      </header>
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
        <section class="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-6">
          <Show when={!conversation()?.turns?.length}>
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
              conversation()?.status !== "sessionReady" &&
              conversation()?.status !== "running"
            }
          >
            <button
              type="button"
              class="rounded-lg bg-accent px-4 py-2 text-sm text-white disabled:opacity-50"
              disabled={connecting() || conversation()?.status === "connecting"}
              onClick={connect}
            >
              {conversation()?.status === "failed"
                ? "다시 연결"
                : "에이전트 연결"}
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
        </section>
        <div class="mx-auto mb-6 w-full max-w-3xl px-6">
          <form
            class="rounded-2xl border border-line bg-panel p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              aria-label="메시지"
              aria-describedby="connection-note"
              class="w-full resize-none bg-transparent text-sm disabled:cursor-not-allowed"
              disabled={!canSend()}
              value={message()}
              onInput={(event) => setMessage(event.currentTarget.value)}
              rows={2}
              placeholder="메시지를 입력하세요"
            />
            <div class="mt-3 flex items-center justify-between text-xs text-muted">
              <span>
                {agents()?.find((agent) => agent.id === conversation()?.agentId)
                  ?.name ?? conversation()?.agentId}
              </span>
              <button
                type="submit"
                disabled={!canSend() || !message().trim()}
                class="rounded-lg bg-accent px-4 py-2 text-white disabled:opacity-40"
              >
                전송
              </button>
            </div>
          </form>
          <p id="connection-note" class="mt-2 text-center text-xs text-muted">
            {conversation()?.status === "running"
              ? "응답이 완료되면 다음 메시지를 보낼 수 있습니다."
              : "연결된 대화에 메시지를 보내세요."}
          </p>
        </div>
      </Show>
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
