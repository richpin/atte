import * as Tabs from "@kobalte/core/tabs";
import { useQueryClient } from "@tanstack/solid-query";
import { GitBranch, RefreshCw } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "shared/ui";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { GitCommit } from "../../api/git-history";
import {
  commitChanges,
  stageFiles,
  unstageFiles,
  type WorkingFile,
  type WorkingSide,
  type WorkingSnapshot,
  workingError,
} from "../../api/git-working";
import {
  clearDraft,
  draftFor,
  selectWorkingFile,
  setDraft,
  setWorkingBusy,
  workingBusy,
  workingQueryKey,
} from "../../model/git-working";
import { useGitWorking } from "../../model/use-git-working";
import { GitHistory } from "./GitHistory";

const tabs = new Map<string, string>();
const expanded = new Map<string, Set<string>>();
type BranchChoice = { value: string; label: string };

export function GitPanel(props: {
  threadId: string;
  visible: boolean;
  onOpenCommit: (root: string, commit: GitCommit) => void;
  onOpenFile: () => void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useGitWorking(props.threadId, () => props.visible);
  const [tab, setTab] = createSignal(tabs.get(props.threadId) ?? "changes");
  const [refreshToken, setRefreshToken] = createSignal(0);
  const [error, setError] = createSignal("");
  const [headChanged, setHeadChanged] = createSignal(false);
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
    query.isFetching ||
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
  const [stagedOpen, setStagedOpen] = createSignal(
    expanded.get(props.threadId)?.has("staged") ?? true,
  );
  const [changesOpen, setChangesOpen] = createSignal(
    expanded.get(props.threadId)?.has("changes") ?? true,
  );
  const [conflictsOpen, setConflictsOpen] = createSignal(
    expanded.get(props.threadId)?.has("conflicts") ?? true,
  );
  const saveExpanded = (name: string, value: boolean) => {
    const next = new Set(
      expanded.get(props.threadId) ?? ["staged", "changes", "conflicts"],
    );
    if (value) next.add(name);
    else next.delete(name);
    expanded.set(props.threadId, next);
  };
  async function operate(
    action: "stage" | "unstage" | "commit",
    ids: string[] = [],
    all = false,
  ) {
    const snapshot = query.data;
    if (!snapshot || disabled()) return;
    setError("");
    setWorkingBusy(snapshot.root, true);
    try {
      let result: WorkingSnapshot;
      if (action === "stage")
        result = await stageFiles(props.threadId, ids, all);
      else if (action === "unstage")
        result = await unstageFiles(props.threadId, ids, all);
      else {
        const draft = draftFor(snapshot.root);
        result = await commitChanges(
          props.threadId,
          [draft.title.trim(), draft.body.trim()].filter(Boolean).join("\n\n"),
          snapshot.head,
          snapshot.indexTree ?? "",
        );
        clearDraft(snapshot.root);
        seenHead = result.head;
        setHeadChanged(false);
        setRefreshToken((value) => value + 1);
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
  function open(file: WorkingFile, side: WorkingSide) {
    selectWorkingFile(props.threadId, { id: file.id, side });
    props.onOpenFile();
  }
  function Section(section: {
    name: "staged" | "changes" | "conflicts";
    title: string;
    entries: WorkingFile[];
    side?: WorkingSide;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
  }) {
    return (
      <Collapsible
        open={section.isOpen}
        onOpenChange={(value) => {
          section.onOpenChange(value);
          saveExpanded(section.name, value);
        }}
      >
        <div class="flex items-center border-b border-line px-3 py-1.5 text-xs">
          <CollapsibleTrigger class="min-w-0 flex-1 text-left font-medium hover:text-accent">
            {section.isOpen ? "▾" : "▸"} {section.title}{" "}
            <span class="text-muted">{section.entries.length}</span>
          </CollapsibleTrigger>
          <Show when={section.side && section.entries.length > 0}>
            <Button
              variant="ghost"
              size="sm"
              class="h-6 px-2 text-[11px]"
              disabled={disabled()}
              onClick={() =>
                void operate(
                  section.side === "staged" ? "unstage" : "stage",
                  [],
                  true,
                )
              }
            >
              {section.side === "staged"
                ? t("git.unstageAll")
                : t("git.stageAll")}
            </Button>
          </Show>
        </div>
        <CollapsibleContent>
          <For each={section.entries}>
            {(file) => (
              <div class="group flex min-w-0 items-center border-b border-line px-3 text-xs hover:bg-panel">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-accent"
                  title={
                    file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
                  }
                  onClick={() => section.side && open(file, section.side)}
                >
                  <span class="min-w-0 flex-1 truncate">
                    {file.path.split("/").at(-1)}
                  </span>
                  <span class="shrink-0 text-muted">
                    {file.status.trim() || "M"}
                  </span>
                </button>
                <Show when={section.side}>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="ml-1 h-6 px-2 text-[11px]"
                    disabled={disabled()}
                    aria-label={`${section.side === "staged" ? t("git.unstage") : t("git.stage")} ${file.path}`}
                    title={
                      section.side === "staged"
                        ? t("git.unstage")
                        : t("git.stage")
                    }
                    onClick={() =>
                      void operate(
                        section.side === "staged" ? "unstage" : "stage",
                        [file.id],
                      )
                    }
                  >
                    {section.side === "staged" ? "−" : "+"}
                  </Button>
                </Show>
              </div>
            )}
          </For>
        </CollapsibleContent>
      </Collapsible>
    );
  }
  return (
    <section
      class="flex h-full min-h-0 min-w-0 flex-col"
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
          <div class="shrink-0 border-b border-line px-3 py-3">
            <div class="flex items-center gap-2">
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
                  class="min-w-0 flex-1"
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
              <Button
                variant="ghost"
                size="icon"
                class="size-8 shrink-0"
                aria-label={t("git.refresh")}
                title={t("git.refresh")}
                onClick={() => void query.refetch()}
              >
                <RefreshCw class="size-3.5" />
              </Button>
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
          <Show when={query.data}>
            <Show when={query.data?.operation}>
              <p class="border-b border-line px-3 py-2 text-xs text-muted">
                {t("git.operationInProgress", {
                  operation: query.data?.operation ?? "",
                })}
              </p>
            </Show>
            <div class="min-h-0 flex-1 overflow-auto">
              <Section
                name="conflicts"
                title={t("git.conflicts")}
                entries={conflicts()}
                isOpen={conflictsOpen()}
                onOpenChange={setConflictsOpen}
              />
              <Section
                name="staged"
                title={t("git.stagedChanges")}
                entries={staged()}
                side="staged"
                isOpen={stagedOpen()}
                onOpenChange={setStagedOpen}
              />
              <Section
                name="changes"
                title={t("git.changes")}
                entries={unstaged()}
                side="unstaged"
                isOpen={changesOpen()}
                onOpenChange={setChangesOpen}
              />
              <Show when={count() === 0}>
                <p class="px-3 py-6 text-center text-xs text-muted">
                  {t("git.clean")}
                </p>
              </Show>
            </div>
            <div class="shrink-0 space-y-2 border-t border-line p-3">
              <input
                class="h-8 w-full rounded border border-line bg-canvas px-2 text-xs"
                aria-label={t("git.commitTitle")}
                placeholder={t("git.commitTitle")}
                value={draftFor(root()).title}
                onInput={(event) =>
                  setDraft(root(), "title", event.currentTarget.value)
                }
              />
              <textarea
                class="min-h-16 w-full resize-y rounded border border-line bg-canvas px-2 py-1 text-xs"
                aria-label={t("git.commitBody")}
                placeholder={t("git.commitBody")}
                value={draftFor(root()).body}
                onInput={(event) =>
                  setDraft(root(), "body", event.currentTarget.value)
                }
              />
              <Show when={error()}>
                <p role="alert" class="text-xs text-error-foreground">
                  {error()}
                </p>
              </Show>
              <Button
                size="sm"
                class="w-full"
                disabled={
                  disabled() ||
                  staged().length === 0 ||
                  !draftFor(root()).title.trim() ||
                  !query.data?.indexTree
                }
                onClick={() => void operate("commit")}
              >
                {t("git.commitStaged")}
              </Button>
            </div>
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
    </section>
  );
}
