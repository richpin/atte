import * as Tabs from "@kobalte/core/tabs";
import { useQueryClient } from "@tanstack/solid-query";
import { ChevronDown, GitBranch, RefreshCw } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "shared/ui";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type { GitCommit } from "../../api/git-history";
import {
  commitChanges,
  restoreFiles,
  stageFiles,
  stashAll,
  stashPop,
  trashFiles,
  unstageFiles,
  type WorkingSnapshot,
  workingError,
} from "../../api/git-working";
import {
  clearDraft,
  draftFor,
  setWorkingBusy,
  workingBusy,
  workingQueryKey,
} from "../../model/git-working";
import { useGitWorking } from "../../model/use-git-working";
import { CommitDialog } from "./CommitDialog";
import { GitHistory } from "./GitHistory";
import {
  type WorkingAction,
  WorkingChanges,
  type WorkingItem,
} from "./WorkingChanges";

const tabs = new Map<string, string>();
type BranchChoice = { value: string; label: string };
type Pending = {
  action: "restore" | "trash";
  ids: string[];
  all: boolean;
  count: number;
  revision: string;
};

export function GitPanel(props: {
  threadId: string;
  visible: boolean;
  onOpenCommit: (root: string, commit: GitCommit) => void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useGitWorking(props.threadId, () => props.visible);
  const [tab, setTab] = createSignal(tabs.get(props.threadId) ?? "changes");
  const [refreshToken, setRefreshToken] = createSignal(0);
  const [error, setError] = createSignal("");
  const [headChanged, setHeadChanged] = createSignal(false);
  const [commitOpen, setCommitOpen] = createSignal(false);
  const [pending, setPending] = createSignal<Pending | null>(null);
  let seenHead: string | null | undefined;
  createEffect(() => {
    const head = query.data?.head;
    if (head === undefined) return;
    if (seenHead !== undefined && seenHead !== head) setHeadChanged(true);
    seenHead = head;
  });
  const root = () => query.data?.root ?? "";
  const files = () => query.data?.files ?? [];
  const staged = createMemo(() => files().filter((file) => file.staged));
  const unstaged = createMemo(() => files().filter((file) => file.unstaged));
  const conflicts = createMemo(() => files().filter((file) => file.conflict));
  const disabled = () =>
    !query.data ||
    query.isError ||
    workingBusy(root()) ||
    Boolean(query.data.operation) ||
    conflicts().length > 0;
  const count = createMemo(() => new Set(files().map((file) => file.id)).size);
  const currentBranch = createMemo<BranchChoice>(() => ({
    value: query.data?.branch ?? query.data?.head ?? "unknown",
    label:
      query.data?.branch ??
      (query.data?.head
        ? `detached HEAD ${query.data.head.slice(0, 7)}`
        : t("git.noCommits")),
  }));

  async function operate(
    action:
      | "stage"
      | "unstage"
      | "restore"
      | "trash"
      | "stashAll"
      | "stashPop"
      | "commit",
    ids: string[] = [],
    all = false,
    expectedRevision?: string,
  ) {
    const snapshot = query.data;
    if (!snapshot || disabled()) return;
    setError("");
    setWorkingBusy(snapshot.root, true);
    try {
      let result: WorkingSnapshot;
      switch (action) {
        case "stage":
          result = await stageFiles(props.threadId, ids, all);
          break;
        case "unstage":
          result = await unstageFiles(props.threadId, ids, all);
          break;
        case "restore":
          result = await restoreFiles(
            props.threadId,
            ids,
            all,
            expectedRevision ?? snapshot.revision,
          );
          break;
        case "trash":
          result = await trashFiles(
            props.threadId,
            ids,
            expectedRevision ?? snapshot.revision,
          );
          break;
        case "stashAll":
          result = await stashAll(props.threadId, snapshot.revision);
          break;
        case "stashPop":
          result = await stashPop(
            props.threadId,
            snapshot.revision,
            snapshot.latestStash,
          );
          break;
        case "commit": {
          const draft = draftFor(snapshot.root);
          result = await commitChanges(
            props.threadId,
            [draft.title.trim(), draft.body.trim()]
              .filter(Boolean)
              .join("\n\n"),
            snapshot.head,
            snapshot.indexTree ?? "",
          );
          clearDraft(snapshot.root);
          setCommitOpen(false);
          seenHead = result.head;
          setHeadChanged(false);
          setRefreshToken((value) => value + 1);
          break;
        }
      }
      await client.cancelQueries({ queryKey: workingQueryKey(snapshot.root) });
      client.setQueryData(workingQueryKey(snapshot.root), result);
    } catch (cause) {
      const message =
        typeof cause === "object" && cause !== null && "message" in cause
          ? String(cause.message)
          : String(cause);
      setError(message);
    } finally {
      setWorkingBusy(snapshot.root, false);
      await client.invalidateQueries({
        queryKey: workingQueryKey(snapshot.root),
      });
    }
  }
  function request(
    action: "restore" | "trash",
    items: WorkingItem[],
    all = false,
  ) {
    const ids = [...new Set(items.map((item) => item.fileId))];
    if (!query.data || (ids.length === 0 && !all)) return;
    setPending({
      action,
      ids,
      all,
      count: all
        ? files().filter((file) => file.status !== "??" && !file.submodule)
            .length
        : ids.length,
      revision: query.data.revision,
    });
  }
  function actionForItems(action: WorkingAction, items: WorkingItem[]) {
    if (action === "restore" || action === "trash") request(action, items);
    else void operate(action, [...new Set(items.map((item) => item.fileId))]);
  }
  return (
    <section
      class="@container flex h-full min-h-0 min-w-0 flex-col"
      aria-label={t("git.title")}
    >
      <Tabs.Root
        value={tab()}
        onChange={(value) => {
          setTab(value);
          tabs.set(props.threadId, value);
        }}
        class="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List
          aria-label={t("git.title")}
          class="flex shrink-0 border-b border-line px-2"
        >
          <Tabs.Trigger
            value="changes"
            class="border-b-2 border-transparent px-3 py-2 text-xs text-muted data-[selected]:border-accent data-[selected]:text-ink"
          >
            {t("git.changes")} <span class="ml-1">{count()}</span>
          </Tabs.Trigger>
          <Tabs.Trigger
            value="history"
            class="border-b-2 border-transparent px-3 py-2 text-xs text-muted data-[selected]:border-accent data-[selected]:text-ink"
          >
            {t("git.history")}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content
          value="changes"
          forceMount
          hidden={tab() !== "changes"}
          class="flex min-h-0 flex-1 flex-col outline-none"
        >
          <div class="shrink-0 border-b border-line px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <GitBranch
                aria-hidden="true"
                class="size-3.5 shrink-0 text-muted"
              />
              <Show
                when={query.data}
                fallback={
                  <span class="min-w-0 flex-1 truncate text-xs text-muted">
                    {t("git.workingBranch")}
                  </span>
                }
              >
                <Select<BranchChoice>
                  class="min-w-28 flex-1"
                  options={[currentBranch()]}
                  optionValue="value"
                  optionTextValue="label"
                  value={currentBranch()}
                  itemComponent={(itemProps) => (
                    <SelectItem item={itemProps.item}>
                      {itemProps.item.rawValue.label}
                    </SelectItem>
                  )}
                >
                  <SelectTrigger
                    class="h-8 rounded-md border-line px-2"
                    aria-label={t("git.workingBranch")}
                  >
                    <SelectValue<BranchChoice> class="truncate">
                      {(state) => state.selectedOption()?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent class="max-h-72 overflow-y-auto border-line bg-menu text-ink" />
                </Select>
              </Show>
              <div class="flex items-center gap-1">
                <div class="inline-flex shrink-0">
                  <Button
                    size="sm"
                    class="h-8 rounded-r-none px-2 text-xs"
                    disabled={disabled() || unstaged().length === 0}
                    onClick={() => void operate("stage", [], true)}
                  >
                    {t("git.stageAll")}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      as={Button}
                      size="sm"
                      class="h-8 rounded-l-none border-l border-primary-foreground/25 px-1"
                      aria-label={t("git.moreActions")}
                    >
                      <ChevronDown class="size-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        disabled={disabled() || unstaged().length === 0}
                        onSelect={() => void operate("stage", [], true)}
                      >
                        {t("git.stageAll")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={disabled() || staged().length === 0}
                        onSelect={() => void operate("unstage", [], true)}
                      >
                        {t("git.unstageAll")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={
                          disabled() ||
                          files().every(
                            (file) => file.status === "??" || file.submodule,
                          )
                        }
                        onSelect={() => request("restore", [], true)}
                      >
                        {t("git.restoreAll")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={disabled() || files().length === 0}
                        onSelect={() => void operate("stashAll")}
                      >
                        {t("git.stashAll")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={disabled() || !query.data?.latestStash}
                        onSelect={() => void operate("stashPop")}
                      >
                        {t("git.stashPop")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  class="h-8 px-2 text-xs"
                  disabled={disabled() || staged().length === 0}
                  onClick={() => {
                    setError("");
                    setCommitOpen(true);
                  }}
                >
                  {t("git.commit")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-8 shrink-0"
                  aria-label={t("git.refresh")}
                  title={t("git.refresh")}
                  onClick={() => {
                    setRefreshToken((value) => value + 1);
                    void query.refetch();
                  }}
                >
                  <RefreshCw class="size-3.5" />
                </Button>
              </div>
            </div>
          </div>
          <Show when={query.isLoading}>
            <p role="status" class="p-4 text-xs text-muted">
              {t("git.loading")}
            </p>
          </Show>
          <Show when={query.isError}>
            <p role="alert" class="p-4 text-xs text-muted">
              {t(`git.${workingError(query.error)}` as "git.failed")}
            </p>
          </Show>
          <Show when={query.data?.operation}>
            <p class="border-b border-line px-3 py-2 text-xs text-muted">
              {t("git.operationInProgress", {
                operation: query.data?.operation ?? "",
              })}
            </p>
          </Show>
          <Show when={error() && !commitOpen()}>
            <p
              role="alert"
              class="border-b border-line px-3 py-2 text-xs text-danger"
            >
              {error()}
            </p>
          </Show>
          <Show when={query.data}>
            {(snapshot) => (
              <WorkingChanges
                threadId={props.threadId}
                visible={props.visible && tab() === "changes"}
                snapshot={snapshot()}
                disabled={disabled()}
                refreshToken={refreshToken()}
                onAction={actionForItems}
              />
            )}
          </Show>
        </Tabs.Content>
        <Tabs.Content
          value="history"
          forceMount
          hidden={tab() !== "history"}
          class="flex min-h-0 flex-1 flex-col outline-none"
        >
          <Show when={headChanged()}>
            <button
              type="button"
              class="w-full border-b border-line px-3 py-2 text-left text-xs text-accent"
              onClick={() => {
                setRefreshToken((value) => value + 1);
                setHeadChanged(false);
              }}
            >
              {t("git.historyChanged")}
            </button>
          </Show>
          <div class="min-h-0 flex-1">
            <GitHistory
              threadId={props.threadId}
              visible={props.visible && tab() === "history"}
              refreshToken={refreshToken()}
              onRefresh={() => setHeadChanged(false)}
              onOpenCommit={props.onOpenCommit}
            />
          </div>
        </Tabs.Content>
      </Tabs.Root>
      <CommitDialog
        open={commitOpen()}
        root={root()}
        disabled={disabled() || staged().length === 0 || !query.data?.indexTree}
        error={error()}
        onOpenChange={setCommitOpen}
        onCommit={() => void operate("commit")}
      />
      <Dialog
        open={Boolean(pending())}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent closeLabel={t("common.cancel")}>
          <DialogHeader>
            <DialogTitle>
              {t(pending()?.action === "trash" ? "git.trash" : "git.restore")}
            </DialogTitle>
            <DialogDescription>
              {t(
                pending()?.action === "trash"
                  ? "git.trashConfirm"
                  : "git.restoreConfirm",
                { count: pending()?.count ?? 0 },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                const confirmation = pending();
                setPending(null);
                if (confirmation)
                  void operate(
                    confirmation.action,
                    confirmation.ids,
                    confirmation.all,
                    confirmation.revision,
                  );
              }}
            >
              {t(pending()?.action === "trash" ? "git.trash" : "git.restore")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
