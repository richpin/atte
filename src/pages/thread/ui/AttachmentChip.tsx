import { useI18n } from "shared/i18n";
import { Show } from "solid-js";
import type { AttachmentKind } from "../model/types";

export function AttachmentChip(props: {
  name: string;
  kind?: AttachmentKind;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const description = () =>
    props.kind === "image"
      ? t("thread.imageAttachmentDescription")
      : props.kind === "audio"
        ? t("thread.audioAttachmentDescription")
        : t("thread.attachmentDescription");
  return (
    <span
      class="inline-flex max-w-48 items-center gap-1 rounded-full border border-current/20 px-2 py-1 text-xs"
      title={description()}
    >
      <Show when={props.kind === "image" || props.kind === "audio"}>
        <span>
          {props.kind === "image" ? t("thread.image") : t("thread.audio")}
        </span>
      </Show>
      <span class="truncate">{props.name}</span>
      <span class="sr-only">. {description()}</span>
      <Show when={props.onRemove}>
        {(remove) => (
          <button
            type="button"
            aria-label={t("thread.removeAttachment", { name: props.name })}
            class="grid size-4 shrink-0 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current"
            onClick={remove()}
          >
            <svg
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </Show>
    </span>
  );
}
