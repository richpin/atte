import { ChevronDown } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "shared/ui";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  Show,
} from "solid-js";

export function WorkLog(props: {
  count: number;
  collecting: boolean;
  children: (visible: Accessor<boolean>) => JSX.Element;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = createSignal(false);
  const collecting = createMemo(() => props.collecting);
  const open = () => collecting() || expanded();

  // A newly closed run folds even if its individual items were expanded.
  // Later result updates must not reset the user's choice for this run.
  createEffect(on(collecting, () => setExpanded(false)));

  return (
    <Collapsible
      open={open()}
      onOpenChange={setExpanded}
      forceMount
      data-work-log=""
      class="-my-2.5 min-w-0"
    >
      <Show when={!collecting()}>
        <CollapsibleTrigger class="flex w-full items-center gap-2 rounded text-left text-muted text-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <ChevronDown
            aria-hidden="true"
            class="size-3.5 shrink-0"
            classList={{ "-rotate-90": !open() }}
          />
          <span>
            {t("thread.workLog.title")} ·{" "}
            {t(
              props.count === 1
                ? "thread.workLog.item"
                : "thread.workLog.items",
              { count: props.count },
            )}
          </span>
        </CollapsibleTrigger>
      </Show>
      <CollapsibleContent
        hidden={!open()}
        data-thread-search-hidden={!open()}
        class="min-w-0"
      >
        <div
          class="flex min-w-0 flex-col gap-1"
          classList={{ "mt-2": !collecting() }}
        >
          {props.children(open)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
