import * as ContextMenu from "@kobalte/core/context-menu";
import { type FileChangeContent, FileChanges } from "features/review-changes";
import { Circle, CircleCheck, FilePlus2 } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Button, FileDiff } from "shared/ui";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Match,
  Show,
  Switch,
} from "solid-js";
import {
  readWorkingFile,
  type WorkingFile,
  type WorkingSide,
  type WorkingSnapshot,
} from "../../api/git-working";
import { prepareCommitPatch } from "../../lib/git-patch";

export type WorkingItem = {
  id: string;
  fileId: string;
  path: string;
  oldPath: string | null;
  additions: number | null;
  deletions: number | null;
  revision: string;
  status: string;
  side: WorkingSide;
  untracked: boolean;
  submodule: boolean;
  exists: boolean;
};
export type WorkingAction = "stage" | "unstage" | "restore" | "trash";

function color(status: string) {
  switch (status) {
    case "A":
      return "text-response-success";
    case "M":
    case "T":
      return "text-response-warning";
    case "D":
    case "U":
      return "text-danger";
    case "R":
    case "C":
      return "text-response-info";
    default:
      return "text-muted";
  }
}

export function workingItems(files: WorkingFile[]): WorkingItem[] {
  return files
    .flatMap((file) => {
      if (file.conflict) return [];
      return (["staged", "unstaged"] as const).flatMap((side) => {
        const change =
          side === "staged" ? file.stagedChange : file.unstagedChange;
        if (!change) return [];
        return [
          {
            id: `${file.id}:${side}`,
            fileId: file.id,
            path: file.path,
            oldPath: change.oldPath,
            additions: change.additions,
            deletions: change.deletions,
            revision: change.revision,
            status: file.status[side === "staged" ? 0 : 1]?.trim() || "M",
            side,
            untracked: file.status === "??",
            submodule: file.submodule,
            exists: file.exists,
          },
        ];
      });
    })
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        (left.side === "staged" ? -1 : 1),
    );
}

function WorkingPatch(props: {
  threadId: string;
  item: WorkingItem;
  context: FileChangeContent;
  refreshToken: number;
}) {
  const { t } = useI18n();
  const [result, { refetch }] = createResource(
    () => `${props.item.id}:${props.item.revision}:${props.refreshToken}`,
    async () => {
      const response = await readWorkingFile(
        props.threadId,
        props.item.fileId,
        props.item.side,
      );
      if (response.kind !== "text") return { kind: response.kind };
      const diff = await prepareCommitPatch(
        response.patch,
        props.item,
        `${props.item.id}:${props.item.revision}`,
      );
      return { kind: "text" as const, patch: response.patch, diff };
    },
  );
  return (
    <Switch>
      <Match when={result.loading}>
        <p role="status" class="p-4 text-xs text-muted">
          {t("git.loadingDiff")}
        </p>
      </Match>
      <Match when={result.error}>
        <div role="alert" class="space-y-2 p-4 text-xs text-muted">
          <p>{t("git.failed")}</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {t("common.retry")}
          </Button>
        </div>
      </Match>
      <Match when={!result.error && result()}>
        {(loaded) => {
          const data = loaded();
          if (data.kind === "text" && data.diff?.hunks.length) {
            return (
              <Show when={props.context.open()}>
                <FileDiff
                  comparison={{ diff: data.diff }}
                  fallback={data.patch}
                  scrollRoot={props.context.scrollRoot}
                  scrollContent={props.context.scrollContent}
                  visible={props.context.visible()}
                />
              </Show>
            );
          }
          return (
            <p class="p-4 text-xs text-muted">
              {t(
                `git.${data.kind === "text" ? "metadataOnly" : data.kind}` as "git.metadataOnly",
              )}
            </p>
          );
        }}
      </Match>
    </Switch>
  );
}

export function WorkingChanges(props: {
  threadId: string;
  visible: boolean;
  snapshot: WorkingSnapshot;
  disabled: boolean;
  refreshToken: number;
  onAction: (action: WorkingAction, items: WorkingItem[]) => void;
}) {
  const { t } = useI18n();
  const items = createMemo(() => workingItems(props.snapshot.files));
  const [selected, setSelected] = createSignal(new Set<string>());
  let anchor: string | undefined;
  createEffect(() => {
    const ids = new Set(items().map((item) => item.id));
    setSelected((previous) => {
      if ([...previous].every((id) => ids.has(id))) return previous;
      return new Set([...previous].filter((id) => ids.has(id)));
    });
    if (anchor && !ids.has(anchor)) anchor = undefined;
  });
  const chosen = () => items().filter((item) => selected().has(item.id));
  function toggle(item: WorkingItem, shift: boolean, nextChecked: boolean) {
    const range =
      shift && anchor
        ? items().slice(
            Math.min(
              items().findIndex((candidate) => candidate.id === anchor),
              items().findIndex((candidate) => candidate.id === item.id),
            ),
            Math.max(
              items().findIndex((candidate) => candidate.id === anchor),
              items().findIndex((candidate) => candidate.id === item.id),
            ) + 1,
          )
        : [item];
    setSelected((previous) => {
      const next = new Set(previous);
      for (const entry of range)
        if (nextChecked) next.add(entry.id);
        else next.delete(entry.id);
      return next;
    });
    anchor = item.id;
  }
  function contextTarget(item: WorkingItem) {
    if (!selected().has(item.id)) {
      setSelected(new Set([item.id]));
      anchor = item.id;
    }
  }
  const menuClass =
    "min-w-44 rounded-xl border border-line bg-menu p-1 text-xs text-ink shadow-md outline-none";
  const menuItemClass =
    "flex cursor-default items-center rounded-lg px-2 py-1.5 outline-none data-[highlighted]:bg-menu-hover data-[disabled]:opacity-50";
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <Show when={props.snapshot.files.some((file) => file.conflict)}>
        <p
          role="status"
          class="border-b border-line px-3 py-2 text-xs text-danger"
        >
          {t("git.conflicts")}:{" "}
          {props.snapshot.files
            .filter((file) => file.conflict)
            .map((file) => file.path)
            .join(", ")}
        </p>
      </Show>
      <FileChanges
        items={items()}
        visible={props.visible}
        empty={<p class="p-4 text-xs text-muted">{t("git.clean")}</p>}
        headerControls={(item) => (
          <>
            <input
              type="checkbox"
              class="size-3.5 shrink-0 accent-accent"
              aria-label={t("git.selectFile", {
                path: item().path,
                side: t(
                  item().side === "staged" ? "git.staged" : "git.unstaged",
                ),
              })}
              checked={selected().has(item().id)}
              onClick={(event) =>
                toggle(item(), event.shiftKey, event.currentTarget.checked)
              }
            />
            <span
              role="img"
              title={t(
                item().untracked
                  ? "git.untracked"
                  : item().side === "staged"
                    ? "git.staged"
                    : "git.unstaged",
              )}
              aria-label={t(
                item().untracked
                  ? "git.untracked"
                  : item().side === "staged"
                    ? "git.staged"
                    : "git.unstaged",
              )}
              class={`flex shrink-0 items-center gap-1 font-mono text-[11px] ${color(item().untracked ? "A" : item().status)}`}
            >
              {item().untracked ? (
                <FilePlus2 class="size-3.5" aria-hidden="true" />
              ) : item().side === "staged" ? (
                <CircleCheck class="size-3.5" aria-hidden="true" />
              ) : (
                <Circle class="size-3.5" aria-hidden="true" />
              )}
              {item().untracked ? "?" : item().status}
            </span>
          </>
        )}
        headerWrapper={(item, header) => (
          <ContextMenu.Root>
            <ContextMenu.Trigger onContextMenu={() => contextTarget(item())}>
              {header()}
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content class={menuClass}>
                {(["stage", "unstage", "restore", "trash"] as const).map(
                  (action) => {
                    const candidates = () =>
                      chosen().filter((entry) =>
                        action === "stage"
                          ? entry.side === "unstaged"
                          : action === "unstage"
                            ? entry.side === "staged"
                            : action === "restore"
                              ? !entry.untracked && !entry.submodule
                              : entry.exists && !entry.submodule,
                      );
                    return (
                      <ContextMenu.Item
                        class={menuItemClass}
                        disabled={props.disabled || candidates().length === 0}
                        onSelect={() => props.onAction(action, candidates())}
                      >
                        {t(`git.${action}` as "git.stage")} (
                        {
                          new Set(candidates().map((entry) => entry.fileId))
                            .size
                        }
                        )
                      </ContextMenu.Item>
                    );
                  },
                )}
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        )}
      >
        {(item, context) => (
          <WorkingPatch
            threadId={props.threadId}
            item={item()}
            context={context}
            refreshToken={props.refreshToken}
          />
        )}
      </FileChanges>
    </div>
  );
}
