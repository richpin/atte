import { openUrl } from "@tauri-apps/plugin-opener";
import { Dot, ExternalLink, Search } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { AgentIcon } from "shared/ui";
import { createResource, createSignal, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  catalog,
  install,
  logout,
  refreshCatalog,
  uninstall,
} from "../api/agents";

import { LogoutAgentDialog } from "./LogoutAgentDialog";
import { UninstallAgentDialog } from "./UninstallAgentDialog";

function safeExternalUrl(destination: string | null | undefined) {
  if (!destination || !/^https?:\/\//i.test(destination)) return undefined;
  try {
    const url = new URL(destination);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function AgentManagementPage(props: {
  active: boolean;
  onAgentsChanged: () => void;
}) {
  const { t, message } = useI18n();
  const [error, setError] = createSignal<string>();
  const [search, setSearch] = createSignal("");
  const [work, setWork] = createStore<
    Record<string, { busy: boolean; operation: "install" | "uninstall" }>
  >({});
  const [logoutWork, setLogoutWork] = createStore<
    Record<string, { pending: boolean; error?: string }>
  >({});
  const [agents, { mutate }] = createResource(
    () => props.active,
    async () => {
      const cached = await catalog();
      mutate(cached);
      try {
        return await refreshCatalog();
      } catch (cause) {
        setError(message(cause, "agents.requestFailed"));
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
      setError(message(cause, "agents.requestFailed"));
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

  async function logoutAgent(id: string) {
    if (logoutWork[id]?.pending) return;
    setLogoutWork(id, { pending: true });
    try {
      await logout(id);
      mutate((current) =>
        current?.map((agent) =>
          agent.id === id
            ? {
                ...agent,
                authentication: {
                  ...agent.authentication,
                  connected: false,
                  authenticated: false,
                  required: false,
                  logoutSupported: false,
                  email: null,
                  plan: null,
                },
              }
            : agent,
        ),
      );
    } catch (cause) {
      setLogoutWork(id, {
        pending: false,
        error: message(cause, "agents.logoutFailed"),
      });
      return;
    }
    setLogoutWork(id, { pending: false });
  }

  return (
    <main class="h-full min-h-0 overflow-y-auto bg-canvas text-ink">
      <section class="mx-auto max-w-3xl space-y-5 px-6 py-8">
        <label class="relative block">
          <span class="sr-only">{t("agents.search")}</span>
          <Search
            aria-hidden="true"
            class="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={search()}
            placeholder={t("agents.search")}
            class="w-full rounded-lg border border-line bg-input-surface py-2.5 pr-4 pl-11 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </label>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
        <Show when={agents.loading && !agents.latest}>
          <p role="status">{t("agents.loading")}</p>
        </Show>
        <Show when={!agents.loading && agents.latest?.length === 0}>
          <p role="status">{t("agents.empty")}</p>
        </Show>
        <Show
          when={
            !agents.loading &&
            (agents.latest?.length ?? 0) > 0 &&
            filteredAgents().length === 0
          }
        >
          <p role="status">{t("agents.noResults")}</p>
        </Show>
        <For each={filteredAgents()}>
          {(agent) => {
            const installing = () =>
              work[agent.id]?.busy && work[agent.id]?.operation === "install";
            const hasAccountDetails = () =>
              agent.authentication.authenticated &&
              (agent.authentication.email ||
                agent.authentication.plan ||
                agent.authentication.logoutSupported);
            const externalUrl = safeExternalUrl(
              agent.website ?? agent.repository,
            );
            return (
              <article class="rounded-2xl border border-line bg-input-surface p-5">
                <div class="flex items-start justify-between gap-5">
                  <div class="flex min-w-0 items-start gap-3">
                    <AgentIcon id={agent.id} src={agent.icon} />
                    <div class="min-w-0 space-y-1">
                      <div class="flex items-center gap-2">
                        <h2 class="font-medium">{agent.name}</h2>
                        <Show when={externalUrl}>
                          {(url) => (
                            <a
                              href={url()}
                              aria-label={t("agents.externalLinkLabel", {
                                name: agent.name,
                              })}
                              class="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                              onClick={(event) => {
                                event.preventDefault();
                                void openUrl(url()).catch(() => undefined);
                              }}
                            >
                              <ExternalLink
                                aria-hidden="true"
                                class="size-3.5"
                              />
                            </a>
                          )}
                        </Show>
                      </div>
                      <p class="text-sm text-muted">{agent.description}</p>
                    </div>
                  </div>
                  <div class="flex shrink-0 items-center gap-3 text-sm">
                    <Show
                      when={agent.installed}
                      fallback={
                        <button
                          type="button"
                          aria-label={`${agent.name} ${installing() ? t("agents.installing") : t("agents.install")}`}
                          disabled={!agent.distribution || installing()}
                          class="rounded-lg bg-panel px-3 py-1.5 text-ink hover:bg-line focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
                          onClick={() => run(agent.id, "install")}
                        >
                          {installing()
                            ? t("agents.installing")
                            : t("agents.install")}
                        </button>
                      }
                    >
                      <span class="text-xs text-muted">
                        {t("agents.installed")}
                      </span>
                      <UninstallAgentDialog
                        name={agent.name}
                        disabled={work[agent.id]?.busy ?? false}
                        onConfirm={() => run(agent.id, "uninstall")}
                      />
                    </Show>
                  </div>
                </div>
                <Show when={hasAccountDetails()}>
                  <div class="mt-4 border-t border-line pt-4 text-sm">
                    <div class="flex flex-wrap items-center gap-3">
                      <div class="flex min-w-0 flex-wrap items-center gap-1">
                        <Show when={agent.authentication.email}>
                          {(email) => <p>{email()}</p>}
                        </Show>
                        <Show
                          when={
                            agent.authentication.email &&
                            agent.authentication.plan
                          }
                        >
                          <Dot
                            aria-hidden="true"
                            class="size-4 shrink-0 text-muted"
                          />
                        </Show>
                        <Show when={agent.authentication.plan}>
                          {(plan) => <p>{plan()}</p>}
                        </Show>
                      </div>
                      <Show when={agent.authentication.logoutSupported}>
                        <div class="ml-auto">
                          <LogoutAgentDialog
                            name={agent.name}
                            pending={logoutWork[agent.id]?.pending ?? false}
                            onConfirm={() => void logoutAgent(agent.id)}
                          />
                        </div>
                      </Show>
                    </div>
                    <Show when={logoutWork[agent.id]?.error}>
                      {(logoutError) => (
                        <p role="alert" class="mt-2 text-sm text-danger">
                          {logoutError()}
                        </p>
                      )}
                    </Show>
                  </div>
                </Show>
              </article>
            );
          }}
        </For>
      </section>
    </main>
  );
}
