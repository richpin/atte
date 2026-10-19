import { Brain, ChevronDown } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Markdown,
  Tailspin,
} from "shared/ui";
import { createSignal, Show } from "solid-js";
import type { ResponsePart } from "../model/types";

export function Thought(props: {
  part: Extract<ResponsePart, { kind: "thought" }>;
  active: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = createSignal(false);

  return (
    <Collapsible
      open={expanded()}
      onOpenChange={setExpanded}
      data-thought=""
      class="min-w-0 rounded-xl border border-line text-sm"
    >
      <CollapsibleTrigger class="flex w-full items-center gap-2 px-3 py-[4.5px] text-left text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <Show
          when={props.active}
          fallback={<Brain aria-hidden="true" class="size-4 shrink-0" />}
        >
          <Tailspin aria-hidden="true" class="inline-flex size-4 shrink-0" />
        </Show>
        <span>{t("thread.thought.title")}</span>
        <ChevronDown
          aria-hidden="true"
          class="size-3.5 shrink-0"
          classList={{ "-rotate-90": !expanded() }}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        data-thread-search-root=""
        data-thread-search-hidden={!expanded()}
        class="border-t border-line px-3 py-3"
      >
        <Show when={expanded()}>
          <Markdown
            source={props.part.text}
            variant="agent"
            streaming={props.active}
            generation={props.part.id}
          />
        </Show>
      </CollapsibleContent>
    </Collapsible>
  );
}
