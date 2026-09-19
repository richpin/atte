import { useI18n } from "shared/i18n";
import { createEffect, on } from "solid-js";

export function PromptInput(props: {
  value: string;
  disabled: boolean;
  focusKey?: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  let input: HTMLTextAreaElement | undefined;

  createEffect(
    on(
      () => props.focusKey,
      (focusKey) => {
        if (focusKey) input?.focus();
      },
    ),
  );

  return (
    <textarea
      ref={input}
      aria-label={t("thread.message")}
      aria-describedby="connection-note"
      class="w-full resize-none bg-transparent text-sm outline-none disabled:cursor-not-allowed"
      disabled={props.disabled}
      value={props.value}
      onInput={(event) => props.onInput(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (
          event.key !== "Enter" ||
          event.shiftKey ||
          event.isComposing ||
          event.keyCode === 229
        )
          return;
        event.preventDefault();
        if (!event.repeat) props.onSubmit();
      }}
      rows={2}
      placeholder={t("thread.messagePlaceholder")}
    />
  );
}
