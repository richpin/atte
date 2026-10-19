import {
  Check,
  ChevronDown,
  Circle,
  Lightbulb,
  LoaderCircle,
} from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "shared/ui";
import { createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Plan as PlanData } from "../model/types";

export function Plan(props: { plan: PlanData; active: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = createSignal(true);
  const completed = () =>
    props.plan.entries.filter((entry) => entry.status === "completed").length;
  const current = () =>
    props.plan.entries.find((entry) => entry.status === "in_progress")?.content;

  return (
    <Show when={props.plan.entries.length > 0}>
      <Collapsible
        open={expanded()}
        onOpenChange={setExpanded}
        data-plan=""
        class="min-w-0 rounded-xl border border-line text-sm"
      >
        <CollapsibleTrigger class="flex w-full min-w-0 items-center gap-2 px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <Lightbulb aria-hidden="true" class="size-4 shrink-0 text-muted" />
          <span class="shrink-0 text-base font-bold">
            {t("thread.plan.title")}
          </span>
          <ChevronDown
            aria-hidden="true"
            class="size-3.5 shrink-0 text-muted"
            classList={{ "-rotate-90": !expanded() }}
          />
          <span class="min-w-0 flex-1 truncate text-muted" title={current()}>
            {!expanded() ? current() : ""}
          </span>
          <span class="shrink-0 text-xs text-muted">
            {t("thread.plan.completed", {
              completed: completed(),
              total: props.plan.entries.length,
            })}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent
          data-thread-search-root=""
          data-thread-search-hidden={!expanded()}
          class="border-t border-line px-3 py-3"
        >
          <PlanEntries entries={props.plan.entries} active={props.active} />
        </CollapsibleContent>
      </Collapsible>
    </Show>
  );
}

export function PlanEntries(props: {
  entries: PlanData["entries"];
  active: boolean;
}) {
  const { t } = useI18n();
  return (
    <ol class="flex flex-col gap-2">
      <For each={props.entries}>
        {(entry) => (
          <li class="flex min-w-0 items-start gap-2">
            <Dynamic
              component={
                entry.status === "completed"
                  ? Check
                  : entry.status === "in_progress"
                    ? LoaderCircle
                    : Circle
              }
              aria-hidden="true"
              class="mt-0.5 size-4 shrink-0 text-muted"
              classList={{
                "animate-spin motion-reduce:animate-none":
                  props.active && entry.status === "in_progress",
              }}
            />
            <span class="sr-only">
              {t(
                entry.status === "completed"
                  ? "thread.plan.done"
                  : `thread.plan.${entry.status}`,
              )}
            </span>
            <span
              class="min-w-0 whitespace-pre-wrap break-words"
              classList={{ "text-muted": entry.status === "completed" }}
            >
              {entry.content}
            </span>
          </li>
        )}
      </For>
    </ol>
  );
}
