import { useI18n } from "shared/i18n";
import { For, Show } from "solid-js";
import type { CheckResult } from "../model/types";

export function ToolsList(props: {
  result?: CheckResult;
  checking?: boolean;
  signingIn?: boolean;
  error?: string;
}) {
  const { t } = useI18n();
  return (
    <div class="space-y-2">
      <Show
        when={props.result?.tools.length}
        fallback={
          <p role="status" class="text-xs text-muted-foreground">
            {props.error
              ? props.error
              : props.signingIn
                ? t("mcps.auth.signingIn")
                : props.checking
                  ? t("mcps.checking")
                  : props.result
                    ? t(`mcps.checkStatus.${props.result.status}`)
                    : t("mcps.toolsUnchecked")}
          </p>
        }
      >
        <ul aria-label={t("mcps.tools")} class="flex flex-wrap gap-2">
          <For each={props.result?.tools}>
            {(tool) => (
              <li class="max-w-full break-all rounded-lg bg-panel px-2 py-1 font-mono text-xs text-foreground">
                {tool}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
