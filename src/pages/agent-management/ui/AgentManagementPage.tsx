import { createResource, createSignal, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { authenticate, catalog, install } from "../api/agents";

export function AgentManagementPage(props: {
  active: boolean;
  onBack: () => void;
  onInstalled: () => void;
}) {
  const [error, setError] = createSignal<string>();
  const [work, setWork] = createStore<
    Record<string, { busy: boolean; message: string; failed: boolean }>
  >({});
  const [agents, { mutate }] = createResource(
    () => props.active,
    async () => {
      const cached = await catalog();
      mutate(cached);
      try {
        return await catalog(true, false);
      } catch (cause) {
        setError(message(cause));
        try {
          return await catalog();
        } catch {
          return [];
        }
      }
    },
    {
      storage: (initial) => {
        const [state, setState] = createStore({ value: initial });
        return [
          () => state.value,
          (next = undefined) => {
            const value = typeof next === "function" ? next(state.value) : next;
            setState("value", reconcile(value));
            return value;
          },
        ];
      },
    },
  );

  async function refresh() {
    setError(undefined);
    try {
      mutate(await catalog(true));
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function run(
    id: string,
    operation: "install" | "inspect" | "login",
    method?: string,
  ) {
    setWork(id, {
      busy: true,
      message: operation === "install" ? "설치 준비 중…" : "에이전트 연결 중…",
      failed: false,
    });
    try {
      if (operation === "install") {
        await install(id, (message) => setWork(id, "message", message));
        props.onInstalled();
        setWork(id, "message", "설치 완료. 연결·인증 확인을 진행하세요.");
      } else {
        if (operation === "login")
          setWork(
            id,
            "message",
            "선택한 인증 방식의 안내를 따라 로그인을 완료해주세요. 최대 10분 동안 기다립니다.",
          );
        const result = await authenticate(id, method);
        setWork(
          id,
          "message",
          result.authenticated
            ? "인증 완료. 대화로 돌아가 새 대화를 시작하거나 다시 연결하세요."
            : "ACP 연결 확인. 인증 여부는 첫 메시지 또는 로그인으로 확인합니다.",
        );
      }
      mutate(await catalog());
    } catch (cause) {
      setWork(id, { message: message(cause), failed: true });
      try {
        mutate(await catalog());
      } catch {
        /* Keep the last catalog visible for retry. */
      }
    } finally {
      setWork(id, "busy", false);
    }
  }

  return (
    <main class="min-h-dvh bg-canvas text-ink">
      <header class="flex h-14 items-center gap-4 border-b border-line px-6">
        <span class="font-semibold">atte</span>
        <h1 class="text-sm font-medium">에이전트 관리</h1>
        <button
          type="button"
          class="ml-auto rounded-lg border border-line px-3 py-1.5 text-xs"
          onClick={props.onBack}
        >
          대화로 돌아가기
        </button>
      </header>
      <section class="mx-auto max-w-3xl space-y-5 px-6 py-8">
        <p class="text-sm text-muted">
          에이전트를 설치하고 로그인한 뒤 작업 폴더에서 대화를 시작하세요.
        </p>
        <div class="flex items-center justify-between text-xs text-muted">
          <span>공식 ACP Registry</span>
          <button type="button" onClick={refresh}>
            목록 새로고침
          </button>
        </div>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
        <Show when={agents.loading && !agents.latest}>
          <p role="status">목록을 불러오는 중…</p>
        </Show>
        <Show when={!agents.loading && agents.latest?.length === 0}>
          <p role="status">
            저장된 목록이 없습니다. 네트워크 연결 후 목록을 새로고침하세요.
          </p>
        </Show>
        <For each={agents.latest ?? []}>
          {(agent) => (
            <article class="space-y-4 rounded-2xl border border-line bg-panel p-5">
              <div class="flex items-center justify-between">
                <h2 class="font-medium">{agent.name}</h2>
                <span class="text-xs text-muted">
                  {agent.installed
                    ? `설치됨 · ${agent.installedVersion}`
                    : agent.installedVersion
                      ? "설치 파일 없음 · 재설치 필요"
                      : "설치되지 않음"}
                </span>
              </div>
              <p class="text-sm text-muted">{agent.description}</p>
              <p class="break-all text-xs text-muted">
                {agent.distribution?.kind === "npm"
                  ? `npm · ${agent.distribution.package}`
                  : agent.distribution?.kind === "binary"
                    ? `macOS 바이너리 · ${agent.availableVersion}`
                    : (agent.unavailableReason ??
                      "현재 플랫폼 배포를 확인할 수 없습니다.")}
              </p>
              <Show when={agent.artifact}>
                <p class="break-all text-xs text-muted">
                  설치 위치: {agent.artifact}
                </p>
              </Show>
              <dl class="grid grid-cols-3 gap-3 text-xs">
                <div>
                  <dt class="text-muted">ACP 연결</dt>
                  <dd>
                    {agent.authentication.connected ? "연결 확인됨" : "미확인"}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">인증</dt>
                  <dd>
                    {agent.authentication.required
                      ? "로그인 필요"
                      : agent.authentication.authenticated
                        ? "인증 완료"
                        : "미확인"}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">대화 실행</dt>
                  <dd>
                    {agent.installed
                      ? agent.authentication.authenticated
                        ? "시작 가능"
                        : agent.authentication.required
                          ? "로그인 후 다시 연결"
                          : "첫 메시지에서 확인"
                      : "설치 필요"}
                  </dd>
                </div>
              </dl>
              <div class="flex flex-wrap gap-3 text-sm">
                <Show when={!agent.installed}>
                  <button
                    type="button"
                    aria-label={`${agent.name} 설치`}
                    disabled={!agent.distribution || work[agent.id]?.busy}
                    class="rounded-lg bg-accent px-4 py-2 text-white disabled:opacity-40"
                    onClick={() => run(agent.id, "install")}
                  >
                    설치
                  </button>
                </Show>
                <Show when={agent.installed}>
                  <button
                    type="button"
                    disabled={work[agent.id]?.busy}
                    class="rounded-lg border border-line px-4 py-2 disabled:opacity-40"
                    onClick={() => run(agent.id, "inspect")}
                  >
                    연결·인증 방법 확인
                  </button>
                  <For each={agent.authentication.methods}>
                    {(method) => (
                      <button
                        type="button"
                        title={method.description ?? undefined}
                        disabled={!method.supported || work[agent.id]?.busy}
                        class="rounded-lg bg-accent px-4 py-2 text-white disabled:opacity-40"
                        onClick={() => run(agent.id, "login", method.id)}
                      >
                        {method.name}
                        {method.supported
                          ? method.terminal
                            ? " · 터미널"
                            : ""
                          : " · 미지원 인증"}
                      </button>
                    )}
                  </For>
                </Show>
              </div>
              <For each={agent.authentication.methods}>
                {(method) => (
                  <Show when={method.description}>
                    <p class="text-xs text-muted">
                      {method.name}: {method.description}
                    </p>
                  </Show>
                )}
              </For>
              <Show when={work[agent.id]?.message}>
                <p
                  role={work[agent.id]?.failed ? "alert" : "status"}
                  class="text-sm"
                >
                  {work[agent.id]?.message}
                </p>
              </Show>
            </article>
          )}
        </For>
      </section>
    </main>
  );
}

function message(cause: unknown) {
  return typeof cause === "string"
    ? cause
    : "요청을 완료할 수 없습니다. 다시 시도해주세요.";
}
