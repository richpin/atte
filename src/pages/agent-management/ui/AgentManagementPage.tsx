import { AgentIcon } from "shared/ui";
import { createResource, createSignal, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { catalog, install, refreshCatalog, uninstall } from "../api/agents";

import { UninstallAgentDialog } from "./UninstallAgentDialog";

export function AgentManagementPage(props: {
  active: boolean;
  onBack: () => void;
  onAgentsChanged: () => void;
}) {
  const [error, setError] = createSignal<string>();
  const [search, setSearch] = createSignal("");
  const [work, setWork] = createStore<
    Record<string, { busy: boolean; operation: "install" | "uninstall" }>
  >({});
  const [agents, { mutate }] = createResource(
    () => props.active,
    async () => {
      const cached = await catalog();
      mutate(cached);
      try {
        return await refreshCatalog();
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
  const filteredAgents = () => {
    const query = search().trim().toLowerCase();
    return query
      ? (agents.latest ?? []).filter((agent) =>
          agent.name.toLowerCase().includes(query),
        )
      : (agents.latest ?? []);
  };

  async function run(id: string, operation: "install" | "uninstall") {
    setError(undefined);
    setWork(id, { busy: true, operation });
    try {
      if (operation === "uninstall") {
        await uninstall(id);
        props.onAgentsChanged();
      } else {
        await install(id);
        props.onAgentsChanged();
      }
      mutate(await catalog());
    } catch (cause) {
      setError(message(cause));
      if (operation === "uninstall") props.onAgentsChanged();
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
          class="ml-auto rounded-lg border border-line px-3 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          onClick={props.onBack}
        >
          스레드로 돌아가기
        </button>
      </header>
      <section class="mx-auto max-w-3xl space-y-5 px-6 py-8">
        <label class="block">
          <span class="sr-only">에이전트 이름 검색</span>
          <input
            type="search"
            value={search()}
            placeholder="에이전트 이름 검색"
            class="w-full rounded-lg border border-line bg-panel px-4 py-2.5 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </label>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
        <Show when={agents.loading && !agents.latest}>
          <p role="status">목록을 불러오는 중…</p>
        </Show>
        <Show when={!agents.loading && agents.latest?.length === 0}>
          <p role="status">
            저장된 목록이 없습니다. 네트워크 연결을 확인해주세요.
          </p>
        </Show>
        <Show
          when={
            !agents.loading &&
            (agents.latest?.length ?? 0) > 0 &&
            filteredAgents().length === 0
          }
        >
          <p role="status">검색 결과가 없습니다.</p>
        </Show>
        <For each={filteredAgents()}>
          {(agent) => {
            const installing = () =>
              work[agent.id]?.busy && work[agent.id]?.operation === "install";
            return (
              <article class="flex items-start justify-between gap-5 rounded-2xl border border-line bg-panel p-5">
                <div class="flex min-w-0 items-start gap-3">
                  <AgentIcon src={agent.icon} />
                  <div class="min-w-0 space-y-1">
                    <h2 class="font-medium">{agent.name}</h2>
                    <p class="text-sm text-muted">{agent.description}</p>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-3 text-sm">
                  <Show
                    when={agent.installed}
                    fallback={
                      <button
                        type="button"
                        aria-label={`${agent.name} ${installing() ? "설치 중" : "설치"}`}
                        disabled={!agent.distribution || installing()}
                        class="rounded-lg bg-accent px-4 py-2 text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
                        onClick={() => run(agent.id, "install")}
                      >
                        {installing() ? "설치 중" : "설치"}
                      </button>
                    }
                  >
                    <span class="text-xs text-muted">설치됨</span>
                    <UninstallAgentDialog
                      name={agent.name}
                      disabled={work[agent.id]?.busy ?? false}
                      onConfirm={() => run(agent.id, "uninstall")}
                    />
                  </Show>
                </div>
              </article>
            );
          }}
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
