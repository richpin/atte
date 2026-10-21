import { ShieldCheck } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { For, type JSX, Show } from "solid-js";
import type { PermissionRequest } from "../model/types";

export function PermissionInput(props: {
  request: PermissionRequest;
  workingFolder: string;
  hideDetails?: boolean;
  disabled: boolean;
  headerActions?: JSX.Element;
  onAnswer: (request: string, option: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section aria-label={t("thread.permission")}>
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="flex items-center gap-2 text-xs text-muted">
          <ShieldCheck aria-hidden="true" class="size-4 shrink-0" />
          {t("thread.permission")}
        </p>
        {props.headerActions}
      </div>
      <h2 class="break-words text-sm font-medium">{props.request.title}</h2>
      <Show when={!props.hideDetails && props.request.details}>
        <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">
          {props.request.details}
        </pre>
      </Show>
      <div class="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3 text-xs">
        <span class="min-w-0 truncate text-muted" title={props.workingFolder}>
          {props.workingFolder}
        </span>
        <div class="flex min-w-0 flex-wrap justify-end gap-2">
          <For each={props.request.options}>
            {(option) => (
              <button
                type="button"
                disabled={props.disabled}
                class="min-w-0 max-w-full whitespace-normal break-words rounded-lg bg-primary px-3 py-2 text-left text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
                onClick={() => props.onAnswer(props.request.id, option.id)}
              >
                {option.name}
              </button>
            )}
          </For>
        </div>
      </div>
    </section>
  );
}
