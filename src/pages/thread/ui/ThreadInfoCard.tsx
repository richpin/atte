import { useI18n } from "shared/i18n";
import { Card, Progress } from "shared/ui";
import { Show } from "solid-js";
import type { ContextUsage } from "../model/types";

function formatTokens(value: number) {
  return value < 1_000
    ? String(value)
    : `${Number((value / 1_000).toFixed(1))}K`;
}

export function ThreadInfoCard(props: { usage: ContextUsage | null }) {
  const { t } = useI18n();
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
    <Card class="absolute top-3 right-6 h-32 w-60 rounded-3xl border-line bg-input-surface p-5 text-ink shadow-sm">
      <h2 class="text-sm font-medium">{t("thread.context")}</h2>
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
    </Card>
  );
}
