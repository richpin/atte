import { ChangeStats } from "features/review-changes";
import { FileDiff } from "lucide-solid";
import { type PreparedFileChange, prepareFileChanges } from "shared/diff";
import { useI18n } from "shared/i18n";
import { createMemo, createResource, Show } from "solid-js";
import { collectTurnChanges } from "../model/turn-changes";
import type { Turn } from "../model/types";

export function TurnChangesSummary(props: {
  turn: Turn;
  active: boolean;
  permissionToolIds?: string[];
  onOpen?: (turnId: string, files: PreparedFileChange[]) => void;
}) {
  const { t } = useI18n();
  const changes = createMemo(() =>
    props.active ? [] : collectTurnChanges(props.turn, props.permissionToolIds),
  );
  const [files, { refetch }] = createResource(
    () => (changes().length ? changes() : false),
    prepareFileChanges,
  );
  const current = () =>
    !props.active && changes().length > 0 && !files.loading && !files.error
      ? files()
      : undefined;
  const totals = () =>
    (current() ?? [])
      .flatMap((file) => file.comparisons)
      .reduce(
        (sum, item) => ({
          additions: sum.additions + item.additions,
          deletions: sum.deletions + item.deletions,
        }),
        { additions: 0, deletions: 0 },
      );
  return (
    <>
      <Show when={current()}>
        {(items) => (
          <button
            type="button"
            class="flex w-full min-w-0 flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-4 text-left hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => props.onOpen?.(props.turn.id, items())}
          >
            <FileDiff aria-hidden="true" class="size-5 shrink-0 text-muted" />
            <span class="min-w-0 flex-1 text-sm font-medium">
              {t("diff.files", { count: items().length })}
            </span>
            <ChangeStats {...totals()} />
            <span class="text-xs text-muted">{t("diff.view")}</span>
          </button>
        )}
      </Show>
      <Show when={!props.active && changes().length > 0 && files.error}>
        <button
          type="button"
          class="text-left text-xs text-muted"
          onClick={() => void refetch()}
        >
          {t("diff.failed")} · {t("common.retry")}
        </button>
      </Show>
    </>
  );
}
