import { X } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Button, Card, Progress } from "shared/ui";
import { Show } from "solid-js";
import type { ContextUsage } from "../model/types";

function formatTokens(value: number) {
  return value < 1_000
    ? String(value)
    : `${Number((value / 1_000).toFixed(1))}K`;
}

export function ThreadInfoCard(props: {
  usage: ContextUsage | null;
  onClose: () => void;
}) {
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
    </Card>
  );
}
