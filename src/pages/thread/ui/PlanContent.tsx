import { ChevronDown } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Markdown,
} from "shared/ui";
import { createSignal, Match, Show, Switch } from "solid-js";
import type { ResponsePart } from "../model/types";
import { PlanEntries } from "./Plan";

export function PlanContent(props: {
  part: Extract<ResponsePart, { kind: "planContent" }>;
  active: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = createSignal(true);
  const visible = () => {
    const content = props.part.content;
    if (!content) return false;
    switch (content.type) {
      case "items":
        return content.entries.length > 0;
      case "markdown":
        return content.content.trim().length > 0;
      case "file":
        return content.uri.trim().length > 0;
    }
  };
  const items = () => {
    const content = props.part.content;
    return content?.type === "items" ? content : undefined;
  };
  const markdown = () => {
    const content = props.part.content;
    return content?.type === "markdown" ? content : undefined;
  };
  const file = () => {
    const content = props.part.content;
    return content?.type === "file" ? content : undefined;
  };
  return (
    <Show when={visible()}>
      <Collapsible
        open={expanded()}
        onOpenChange={setExpanded}
        data-plan-content=""
        class="min-w-0 rounded-lg border border-line text-sm"
      >
        <CollapsibleTrigger class="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <ChevronDown
            aria-hidden="true"
            class="size-3.5 shrink-0 text-muted"
            classList={{ "-rotate-90": !expanded() }}
          />
          <span class="flex-1">{t("thread.planContent.title")}</span>
          <Show when={items()}>
            {(plan) => (
              <span class="shrink-0 text-xs text-muted">
                {t("thread.plan.completed", {
                  completed: plan().entries.filter(
                    (entry) => entry.status === "completed",
                  ).length,
                  total: plan().entries.length,
                })}
              </span>
            )}
          </Show>
        </CollapsibleTrigger>
        <CollapsibleContent class="min-w-0 border-t border-line px-3 py-3">
          <Switch>
            <Match when={items()}>
              {(plan) => (
                <PlanEntries entries={plan().entries} active={props.active} />
              )}
            </Match>
            <Match when={markdown()}>
              {(plan) => (
                <Markdown
                  source={plan().content}
                  variant="agent"
                  streaming={props.active}
                  generation={props.part.id}
                />
              )}
            </Match>
            <Match when={file()}>
              {(plan) => (
                <div>
                  <p class="mb-2 text-muted">{t("thread.planContent.file")}</p>
                  <p class="whitespace-pre-wrap break-all">{plan().uri}</p>
                </div>
              )}
            </Match>
          </Switch>
        </CollapsibleContent>
      </Collapsible>
    </Show>
  );
}
