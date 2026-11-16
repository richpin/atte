import { ArrowRight, CircleAlert, X } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Button,
  Card,
  Progress,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "shared/ui";
import { createMemo, For, Show } from "solid-js";
import type { ContextUsage, Thread } from "../model/types";

function formatTokens(value: number) {
  return value < 1_000
    ? String(value)
    : `${Number((value / 1_000).toFixed(1))}K`;
}

export function ThreadInfoCard(props: {
  usage: ContextUsage | null;
  mcp?: Thread["mcp"];
  onManageMcps: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const servers = createMemo(() =>
    [...(props.mcp?.servers ?? [])].sort((a, b) => a.localeCompare(b)),
  );
  const usage = () =>
    props.usage && props.usage.size > 0 ? props.usage : null;
  const percentage = () => {
    const current = usage();
    return current ? (current.used / current.size) * 100 : 0;
  };
  const exactUsage = () => {
    const current = usage();
    return current
      ? t("thread.contextUsageExact", {
          used: current.used.toLocaleString(),
          size: current.size.toLocaleString(),
        })
      : "";
  };

  return (
    <Card class="absolute top-3 right-6 w-60 rounded-3xl border-line bg-input-surface p-5 text-ink shadow-sm">
      <h2 class="pr-7 text-sm font-medium">{t("thread.context")}</h2>
      <Button
        variant="ghost"
        size="icon"
        class="absolute top-3.5 right-3.5 size-6 text-muted hover:text-ink"
        aria-label={t("thread.closeInformation")}
        title={t("thread.closeInformation")}
        onClick={props.onClose}
      >
        <X aria-hidden="true" class="size-2.5" />
      </Button>
      <Show
        when={usage()}
        fallback={
          <p class="mt-3 text-xs text-muted">
            {t("thread.contextUsageUnavailable")}
          </p>
        }
      >
        {(current) => (
          <>
            <p class="mt-3 mb-3 text-xs tabular-nums" title={exactUsage()}>
              {Math.round(percentage())}% ({formatTokens(current().used)}/
              {formatTokens(current().size)})
            </p>
            <Progress
              value={Math.min(100, Math.max(0, percentage()))}
              aria-label={t("thread.context")}
              getValueLabel={exactUsage}
            />
          </>
        )}
      </Show>
      <section class="mt-5 border-t border-line pt-4" aria-label="MCP">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-medium">
            MCP<Show when={props.mcp?.servers}> · {servers().length}</Show>
          </h2>
          <Button
            variant="ghost"
            size="icon"
            class="size-6 text-muted hover:text-ink"
            aria-label={t("thread.manageMcps")}
            title={t("thread.manageMcps")}
            onClick={props.onManageMcps}
          >
            <ArrowRight aria-hidden="true" class="size-3.5" />
          </Button>
        </div>
        <Show when={props.mcp?.error}>
          {(error) => (
            <p class="mt-3 break-words text-xs text-muted">{error()}</p>
          )}
        </Show>
        <Show when={!props.mcp?.error}>
          <Show
            when={props.mcp?.servers}
            fallback={
              <p class="mt-3 text-xs text-muted">
                {t("thread.mcpUnavailable")}
              </p>
            }
          >
            <Show
              when={servers().length}
              fallback={
                <p class="mt-3 text-xs text-muted">{t("thread.mcpEmpty")}</p>
              }
            >
              <ul class="mt-2 max-h-30 overflow-y-auto" aria-label="MCP">
                <For each={servers()}>
                  {(name) => {
                    const issue = () =>
                      props.mcp?.issues.find((item) => item.name === name);
                    return (
                      <li class="flex h-6 items-center gap-1.5 text-xs">
                        <span class="truncate" title={name}>
                          {name}
                        </span>
                        <Show when={issue()}>
                          {(problem) => (
                            <Tooltip placement="left">
                              <TooltipTrigger
                                class="shrink-0 text-muted hover:text-ink"
                                aria-label={t("thread.mcpIssue", { name })}
                              >
                                <CircleAlert
                                  aria-hidden="true"
                                  class="size-3.5"
                                />
                              </TooltipTrigger>
                              <TooltipContent class="max-w-64 break-words border-line bg-menu text-ink">
                                {problem().reason}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </section>
    </Card>
  );
}
