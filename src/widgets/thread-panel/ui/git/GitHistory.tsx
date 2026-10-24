import { createVirtualizer } from "@tanstack/solid-virtual";
import { GitBranch, RefreshCw } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "shared/ui";
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js";
import {
  type GitCommit,
  type GitRepository,
  historyError,
} from "../../api/git-history";
import {
  COMMIT_ROW_HEIGHT,
  edgePath,
  type GraphRow,
  graphWidth,
  laneX,
} from "../../lib/git-graph";
import { createHistoryModel } from "../../model/git-history";

type BranchChoice = { value: string; label: string };
const ALL_BRANCHES = "all";
const laneColor = (color: number) => `var(--color-git-lane-${color + 1})`;

function CommitRow(props: {
  row: GraphRow;
  width: number;
  repository: GitRepository | undefined;
  onOpen: () => void;
  buttonRef: (button: HTMLButtonElement) => () => void;
  onNavigate: (event: KeyboardEvent) => void;
  index: number;
}) {
  const { locale } = useI18n();
  const commit = () => props.row.commit;
  const references = () =>
    props.repository?.references.filter((ref) => ref.oid === commit().oid) ??
    [];
  const date = () =>
    new Intl.DateTimeFormat(locale(), {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(commit().timestamp * 1000);
  return (
    <button
      ref={(button) => onCleanup(props.buttonRef(button))}
      type="button"
      data-commit-index={props.index}
      onClick={props.onOpen}
      onKeyDown={props.onNavigate}
      title={`${commit().subject}\n${commit().oid}\n${commit().author} · ${date()}`}
      aria-label={`${commit().subject} · ${commit().oid.slice(0, 7)}`}
      class="flex h-full w-full items-center pr-3 text-left hover:bg-panel focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
    >
      <svg
        aria-hidden="true"
        width={props.width}
        height={COMMIT_ROW_HEIGHT}
        class="shrink-0 overflow-visible"
      >
        <For each={props.row.edges}>
          {(edge) => (
            <path
              d={edgePath(edge)}
              fill="none"
              stroke={laneColor(edge.color)}
              stroke-width="1.5"
            />
          )}
        </For>
        <circle
          cx={laneX(props.row.lane)}
          cy={COMMIT_ROW_HEIGHT / 2}
          r={commit().parents.length > 1 ? 4.5 : 3.5}
          fill="var(--color-canvas)"
          stroke={laneColor(props.row.color)}
          stroke-width="2"
        />
      </svg>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-xs font-medium">
          {commit().subject || commit().oid.slice(0, 7)}
        </span>
        <span class="mt-1 flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-muted">
          <Show when={props.repository?.head === commit().oid}>
            <span class="shrink-0 rounded border border-line px-1 text-ink">
              HEAD
            </span>
          </Show>
          <For each={references()}>
            {(ref) => (
              <span
                class="max-w-40 shrink-0 truncate rounded border border-line px-1 text-ink"
                title={ref.name}
              >
                {ref.label}
              </span>
            )}
          </For>
          <span class="shrink-0 font-mono">{commit().oid.slice(0, 7)}</span>
          <span class="truncate">{commit().author}</span>
        </span>
      </span>
      <time
        datetime={new Date(commit().timestamp * 1000).toISOString()}
        class="ml-4 hidden shrink-0 text-[11px] text-muted @min-[600px]:block"
      >
        {date()}
      </time>
    </button>
  );
}

export function GitHistory(props: {
  threadId: string;
  visible: boolean;
  refreshToken?: number;
  onRefresh?: () => void;
  onOpenCommit: (repository: string, commit: GitCommit) => void;
}) {
  const { t } = useI18n();
  const model = createHistoryModel(props.threadId);
  let scrollRoot!: HTMLDivElement;
  let initialized = false;
  let appliedRefreshToken = props.refreshToken ?? 0;
  const buttons = new Map<number, HTMLButtonElement>();
  const options = createMemo<BranchChoice[]>(() => [
    { value: ALL_BRANCHES, label: t("git.allBranches") },
    ...(model
      .repository()
      ?.references.filter((ref) => ref.kind !== "tag")
      .map((ref) => ({ value: ref.name, label: ref.label })) ?? []),
  ]);
  const maxLanes = createMemo((previous: number) => {
    const rows = model.rows();
    return rows.length
      ? Math.max(previous, ...rows.slice(-200).map((row) => row.lanes))
      : 1;
  }, 1);
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return model.rows().length;
    },
    get enabled() {
      return props.visible;
    },
    getScrollElement: () => scrollRoot,
    estimateSize: () => COMMIT_ROW_HEIGHT,
    getItemKey: (index) => model.rows()[index]?.commit.oid ?? index,
    overscan: 8,
  });
  createEffect(() => {
    if (props.visible && !initialized) {
      initialized = true;
      appliedRefreshToken = props.refreshToken ?? 0;
      void model.refresh();
    }
  });
  createEffect(() => {
    const token = props.refreshToken ?? 0;
    if (props.visible && initialized && token !== appliedRefreshToken) {
      appliedRefreshToken = token;
      void model.refresh();
    }
  });
  createEffect(() => {
    model.revision();
    virtualizer.scrollToOffset(0);
  });
  createEffect(() => {
    const items = virtualizer.getVirtualItems();
    const last = items.at(-1);
    if (props.visible && last && last.index >= model.rows().length - 12)
      void model.loadMore();
  });
  function navigate(event: KeyboardEvent) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("[data-commit-index]");
    if (!button) return;
    event.preventDefault();
    const current = Number(button.dataset.commitIndex);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? model.rows().length - 1
          : Math.max(
              0,
              Math.min(
                model.rows().length - 1,
                current + (event.key === "ArrowDown" ? 1 : -1),
              ),
            );
    virtualizer.scrollToIndex(index, { align: "auto" });
    requestAnimationFrame(() =>
      buttons.get(index)?.focus({ preventScroll: true }),
    );
  }
  return (
    <section
      class="@container flex h-full min-h-0 min-w-0 flex-col"
      aria-label={t("git.title")}
    >
      <header class="shrink-0 border-b border-line px-3 py-3">
        <div class="flex items-center gap-2">
          <GitBranch aria-hidden="true" class="size-3.5 shrink-0 text-muted" />
          <Select<BranchChoice>
            class="min-w-0 flex-1"
            options={options()}
            optionValue="value"
            optionTextValue="label"
            value={
              options().find(
                (choice) =>
                  choice.value === (model.reference() ?? ALL_BRANCHES),
              ) ?? {
                value: model.reference() ?? ALL_BRANCHES,
                label: model.reference() ?? t("git.allBranches"),
              }
            }
            onChange={(choice) => {
              if (
                choice &&
                choice.value !== (model.reference() ?? ALL_BRANCHES)
              )
                void model.refresh(
                  choice.value === ALL_BRANCHES ? null : choice.value,
                );
            }}
            itemComponent={(itemProps) => (
              <SelectItem item={itemProps.item}>
                {itemProps.item.rawValue.label}
              </SelectItem>
            )}
          >
            <SelectTrigger
              class="h-8 rounded-md border-line px-2"
              aria-label={t("git.branch")}
            >
              <SelectValue<BranchChoice> class="truncate">
                {(state) => state.selectedOption()?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent class="max-h-72 overflow-y-auto border-line bg-menu text-ink" />
          </Select>
          <Button
            variant="ghost"
            size="icon"
            class="size-8 shrink-0"
            aria-label={t("git.refresh")}
            title={t("git.refresh")}
            onClick={() => {
              props.onRefresh?.();
              void model.refresh();
            }}
          >
            <RefreshCw class="size-3.5" />
          </Button>
        </div>
      </header>
      <Show when={model.repository()?.shallow}>
        <p class="border-b border-line px-3 py-2 text-xs text-muted">
          {t("git.shallow")}
        </p>
      </Show>
      <div ref={scrollRoot} class="min-h-0 flex-1 overflow-auto">
        <ol
          aria-label={t("git.history")}
          class="relative"
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            "min-width": `${graphWidth(maxLanes()) + 210}px`,
          }}
        >
          <For each={virtualizer.getVirtualItems()}>
            {(item) => (
              <li
                aria-posinset={item.index + 1}
                class="absolute left-0 top-0 w-full"
                style={{
                  height: `${item.size}px`,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <Show when={model.rows()[item.index]}>
                  {(row) => (
                    <CommitRow
                      row={row()}
                      width={graphWidth(maxLanes())}
                      repository={model.repository()}
                      index={item.index}
                      buttonRef={(button) => {
                        const index = item.index;
                        buttons.set(index, button);
                        return () => buttons.delete(index);
                      }}
                      onNavigate={navigate}
                      onOpen={() => {
                        const root = model.repository()?.root;
                        if (root) props.onOpenCommit(root, row().commit);
                      }}
                    />
                  )}
                </Show>
              </li>
            )}
          </For>
        </ol>
        <Show when={model.loading()}>
          <p role="status" class="px-3 py-5 text-center text-xs text-muted">
            {t("git.loading")}
          </p>
        </Show>
        <Show when={model.error()}>
          {(error) => (
            <div role="alert" class="space-y-3 px-4 py-5 text-xs text-muted">
              <p>
                {t(
                  `git.${historyError(error())}` as
                    | "git.failed"
                    | "git.notRepository"
                    | "git.unavailable",
                )}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void model.refresh()}
              >
                {t("git.refresh")}
              </Button>
              <Show when={model.reference()}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void model.refresh(null)}
                >
                  {t("git.allBranches")}
                </Button>
              </Show>
            </div>
          )}
        </Show>
        <Show
          when={!model.loading() && !model.error() && model.rows().length === 0}
        >
          <p class="px-4 py-6 text-center text-xs text-muted">
            {t("git.empty")}
          </p>
        </Show>
        <Show when={model.cursor() && !model.loading() && !model.error()}>
          <div class="px-3 py-2 text-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void model.loadMore()}
            >
              {t("git.loadMore")}
            </Button>
          </div>
        </Show>
      </div>
      <footer class="shrink-0 border-t border-line px-3 py-2 text-[11px] text-muted">
        {t("git.localSnapshot")}
      </footer>
    </section>
  );
}
