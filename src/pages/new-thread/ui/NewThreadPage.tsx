import { ArrowRight, Bot, ChevronDown, Folder } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  AgentIcon,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "shared/ui";
import { Show } from "solid-js";

type NewThreadAgent = {
  id: string;
  name: string;
};

export function NewThreadPage(props: {
  agents: NewThreadAgent[];
  selectedAgent: string;
  selectedFolder?: string;
  loading: boolean;
  failed: boolean;
  selecting: boolean;
  onSelectAgent: (id: string) => void;
  onSelectFolder: () => void;
  onStart: () => void;
  onManageAgents: () => void;
}) {
  const { t } = useI18n();
  const folderName = () =>
    props.selectedFolder?.split(/[\\/]/).filter(Boolean).at(-1) ||
    props.selectedFolder;
  const disabled = () => props.loading || props.failed || props.selecting;

  return (
    <main class="flex h-full min-h-0 flex-col overflow-y-auto bg-canvas text-ink">
      <section class="@container m-auto w-full max-w-xl space-y-6 px-6 py-10">
        <div class="space-y-4">
          <h1 class="text-3xl font-medium tracking-tight">
            {t("thread.empty.title")}
          </h1>
          <p class="text-lg text-muted">{t("thread.empty.description")}</p>
        </div>
        <div class="divide-y divide-line rounded-xl border border-line bg-panel px-4">
          <div class="grid grid-cols-1 @sm:grid-cols-[9.5rem_minmax(0,1fr)] items-center gap-3 py-3">
            <span
              id="new-thread-folder-label"
              class="flex items-center gap-2 whitespace-nowrap text-sm text-muted"
            >
              <Folder aria-hidden="true" class="size-4 shrink-0" />
              {t("thread.workingFolder")}
            </span>
            <button
              type="button"
              aria-describedby="new-thread-folder-label"
              class="flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
              disabled={disabled()}
              onClick={props.onSelectFolder}
            >
              <span class="min-w-0 truncate">
                {props.selecting
                  ? t("thread.selecting")
                  : folderName() || t("thread.selectFolder")}
              </span>
              <ChevronDown
                aria-hidden="true"
                class="size-4 shrink-0 text-muted"
              />
            </button>
          </div>
          <div class="grid grid-cols-1 @sm:grid-cols-[9.5rem_minmax(0,1fr)] items-center gap-3 py-3">
            <label
              for="new-thread-agent"
              class="flex items-center gap-2 whitespace-nowrap text-sm text-muted"
            >
              <Bot aria-hidden="true" class="size-4 shrink-0" />
              {t("thread.agent")}
            </label>
            <Show
              when={props.loading || props.failed || props.agents.length}
              fallback={
                <Button
                  variant="ghost"
                  class="justify-start px-2 font-normal"
                  onClick={props.onManageAgents}
                >
                  {t("thread.manageAgents")}
                </Button>
              }
            >
              <Select<NewThreadAgent>
                class="min-w-0"
                options={props.agents}
                optionValue="id"
                optionTextValue="name"
                placeholder={t("thread.selectAgent")}
                value={
                  props.agents.find(
                    (agent) => agent.id === props.selectedAgent,
                  ) ?? null
                }
                disabled={disabled() || !props.agents.length}
                onChange={(agent) => agent && props.onSelectAgent(agent.id)}
                itemComponent={(itemProps) => (
                  <SelectItem item={itemProps.item} class="min-h-9">
                    <span class="flex items-center gap-2 [[data-theme=dark]_&_img]:invert">
                      <AgentIcon
                        id={itemProps.item.rawValue.id}
                        src={null}
                        compact
                      />
                      {itemProps.item.rawValue.name}
                    </span>
                  </SelectItem>
                )}
              >
                <SelectTrigger
                  id="new-thread-agent"
                  aria-label={t("thread.newThreadAgent")}
                  class="min-w-0 gap-2 border-0 px-2 text-sm font-normal"
                >
                  <SelectValue<NewThreadAgent> class="min-w-0">
                    {(state) => (
                      <Show when={state.selectedOption()}>
                        {(agent) => (
                          <span class="flex min-w-0 items-center gap-2 [[data-theme=dark]_&_img]:invert">
                            <AgentIcon id={agent().id} src={null} compact />
                            <span class="truncate">{agent().name}</span>
                          </span>
                        )}
                      </Show>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent class="max-w-[calc(100vw-2rem)] border-line bg-menu text-ink" />
              </Select>
            </Show>
          </div>
        </div>
        <div class="flex justify-end">
          <Button
            class="rounded-xl"
            disabled={
              disabled() || !props.selectedFolder || !props.selectedAgent
            }
            onClick={props.onStart}
          >
            {t("thread.startThread")}
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      </section>
    </main>
  );
}
