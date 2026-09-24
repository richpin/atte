import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { useI18n } from "shared/i18n";
import { createEffect, on, onMount } from "solid-js";

const minimumLines = 2;
const maximumLines = 10;
const fallbackLineHeight = 20;

export function PromptInput(props: {
  value: string;
  disabled: boolean;
  focusKey?: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onPasteImage?: (image: File) => void;
  onUnsupportedImagePaste?: () => void;
}) {
  const { t } = useI18n();
  let input: HTMLTextAreaElement | undefined;

  function resizeInput() {
    if (!input) return;
    const styles = getComputedStyle(input);
    const measuredLineHeight = Number.parseFloat(styles.lineHeight);
    const lineHeight = Number.isFinite(measuredLineHeight)
      ? measuredLineHeight
      : fallbackLineHeight;
    const pixels = (value: string) => Number.parseFloat(value) || 0;
    const padding = pixels(styles.paddingTop) + pixels(styles.paddingBottom);
    const border =
      pixels(styles.borderTopWidth) + pixels(styles.borderBottomWidth);
    const minimumHeight = lineHeight * minimumLines + padding + border;
    const maximumHeight = lineHeight * maximumLines + padding + border;
    input.style.height = "0px";
    input.style.height = `${Math.min(
      Math.max(input.scrollHeight + border, minimumHeight),
      maximumHeight,
    )}px`;
  }

  createEffect(
    on(
      () => props.focusKey,
      (focusKey) => {
        if (focusKey) input?.focus();
      },
    ),
  );
  createEffect(
    on(
      () => props.value,
      () => queueMicrotask(resizeInput),
    ),
  );
  onMount(() => {
    if (typeof ResizeObserver !== "undefined") {
      let width = -1;
      const { observe } = makeResizeObserver((entries) => {
        const nextWidth =
          entries[0]?.contentRect.width ?? input?.clientWidth ?? 0;
        if (nextWidth === width) return;
        width = nextWidth;
        resizeInput();
      });
      if (input) observe(input);
    }
    resizeInput();
  });

  return (
    <textarea
      ref={input}
      aria-label={t("thread.message")}
      aria-describedby="connection-note"
      class="max-h-thread-composer-input w-full resize-none overflow-y-auto overscroll-contain bg-transparent text-sm leading-5 outline-none disabled:cursor-not-allowed"
      disabled={props.disabled}
      value={props.value}
      onInput={(event) => {
        props.onInput(event.currentTarget.value);
        resizeInput();
      }}
      onPaste={(event) => {
        const clipboard = event.clipboardData;
        if (!clipboard || clipboard.getData("text/plain").length > 0) return;
        const image = [...clipboard.files].find((file) =>
          file.type.startsWith("image/"),
        );
        if (!image) return;
        event.preventDefault();
        if (props.onPasteImage) props.onPasteImage(image);
        else props.onUnsupportedImagePaste?.();
      }}
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
