import { createSignal, Show } from "solid-js";
import { selectWorkingFolder } from "../api/conversations";
import type { Conversation } from "../model/types";

export function ConversationPage() {
  const [conversation, setConversation] = createSignal<Conversation>();
  const [error, setError] = createSignal<string>();
  const [selecting, setSelecting] = createSignal(false);

  async function selectFolder() {
    if (selecting()) return;
    setSelecting(true);
    setError(undefined);
    try {
      const draft = await selectWorkingFolder();
      if (draft) setConversation(draft);
    } catch (cause) {
      setError(
        typeof cause === "object" &&
          cause !== null &&
          "message" in cause &&
          typeof cause.message === "string"
          ? cause.message
          : "폴더 선택을 완료할 수 없습니다. 다시 시도해주세요.",
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
              <span class="shrink-0 text-xs text-muted">연결 전</span>
            </>
          )}
        </Show>
        <button
          type="button"
          class="ml-auto shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs hover:bg-panel disabled:opacity-50"
          disabled={selecting()}
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
        <section class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <h2 class="text-lg font-medium">대화가 준비되었습니다</h2>
          <p class="text-sm text-muted">아직 에이전트에 연결되지 않았습니다.</p>
        </section>
        <div class="mx-auto mb-6 w-full max-w-3xl px-6">
          <div class="rounded-2xl border border-line bg-panel p-4">
            <textarea
              aria-label="메시지"
              aria-describedby="connection-note"
              class="w-full resize-none bg-transparent text-sm disabled:cursor-not-allowed"
              disabled
              rows={2}
              placeholder="에이전트 연결 후 메시지를 보낼 수 있습니다"
            />
            <div class="mt-3 flex items-center justify-between text-xs text-muted">
              <span>Codex</span>
              <button
                type="button"
                disabled
                class="rounded-lg bg-accent px-4 py-2 text-white opacity-40"
              >
                전송
              </button>
            </div>
          </div>
          <p id="connection-note" class="mt-2 text-center text-xs text-muted">
            연결 전에는 메시지를 보낼 수 없습니다.
          </p>
        </div>
      </Show>
    </main>
  );
}
