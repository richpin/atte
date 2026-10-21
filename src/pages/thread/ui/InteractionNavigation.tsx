import { ChevronLeft, ChevronRight } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Show } from "solid-js";

export function InteractionNavigation(props: {
  index: number;
  count: number;
  disabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  const buttonClass =
    "grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-menu-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40";
  return (
    <Show when={props.count > 1}>
      <nav
        aria-label={t("thread.elicitation.navigation")}
        class="flex shrink-0 items-center gap-1"
      >
        <button
          type="button"
          class={buttonClass}
          aria-label={t("thread.elicitation.previous")}
          disabled={props.disabled || props.index === 0}
          onClick={props.onPrevious}
        >
          <ChevronLeft aria-hidden="true" class="size-4" />
        </button>
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          class="min-w-10 text-center text-xs tabular-nums text-muted"
        >
          {props.index + 1} / {props.count}
        </span>
        <button
          type="button"
          class={buttonClass}
          aria-label={t("thread.elicitation.next")}
          disabled={props.disabled || props.index === props.count - 1}
          onClick={props.onNext}
        >
          <ChevronRight aria-hidden="true" class="size-4" />
        </button>
      </nav>
    </Show>
  );
}
