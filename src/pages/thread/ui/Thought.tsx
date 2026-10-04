import { Brain, ChevronDown, LoaderCircle } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Markdown,
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
      class="min-w-0 rounded-lg border border-line text-sm"
    >
      <CollapsibleTrigger class="flex w-full items-center gap-2 px-3 py-2 text-left text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <ChevronDown
          aria-hidden="true"
          class="size-3.5 shrink-0"
          classList={{ "-rotate-90": !expanded() }}
        />
        <Show
          when={props.active}
          fallback={<Brain aria-hidden="true" class="size-4 shrink-0" />}
        >
          <LoaderCircle
            aria-hidden="true"
            class="size-4 shrink-0 animate-spin motion-reduce:animate-none"
          />
        </Show>
        <span>{t("thread.thought.title")}</span>
      </CollapsibleTrigger>
      <CollapsibleContent class="border-t border-line px-3 py-3">
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
