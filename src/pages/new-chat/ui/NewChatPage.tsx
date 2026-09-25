import { useI18n } from "shared/i18n";
import { For, Show } from "solid-js";

type NewChatAgent = {
  id: string;
  name: string;
};

export function NewChatPage(props: {
  agents: NewChatAgent[];
  selectedAgent: string;
  loading: boolean;
  failed: boolean;
  selecting: boolean;
  error?: string;
  onSelectAgent: (id: string) => void;
  onSelectFolder: () => void;
}) {
  const { t } = useI18n();

  return (
    <main class="flex h-full min-h-0 flex-col overflow-y-auto bg-canvas text-ink">
      <section class="m-auto flex w-full max-w-lg flex-col items-center gap-5 px-6 py-10 text-center">
        <div class="space-y-2">
          <h1 class="text-xl font-medium">{t("thread.empty.title")}</h1>
          <p class="text-sm text-muted">{t("thread.empty.description")}</p>
        </div>
        <Show when={props.error}>
          {(error) => (
            <p role="alert" class="text-sm text-danger">
              {error()}
            </p>
          )}
        </Show>
        <div class="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-line bg-panel p-4 text-left">
          <label class="flex flex-col gap-2 text-xs text-muted">
            {t("thread.newThreadAgent")}
            <select
              aria-label={t("thread.newThreadAgent")}
              class="rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              value={props.selectedAgent}
              disabled={props.loading || props.failed || !props.agents.length}
              onChange={(event) =>
                props.onSelectAgent(event.currentTarget.value)
              }
            >
              <For each={props.agents}>
                {(agent) => <option value={agent.id}>{agent.name}</option>}
              </For>
            </select>
          </label>
          <button
            type="button"
            class="rounded-lg bg-primary px-4 py-2.5 text-primary-foreground text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-50"
            disabled={props.loading || props.failed || props.selecting}
            onClick={props.onSelectFolder}
          >
            {props.selecting ? t("thread.selecting") : t("thread.selectFolder")}
          </button>
        </div>
      </section>
    </main>
  );
}
