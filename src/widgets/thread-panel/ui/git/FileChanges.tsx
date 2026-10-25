import { ChangeStats } from "features/review-changes";
import { ChevronDown, ChevronsDownUp, ChevronsUpDown } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "shared/ui";
import {
  type Accessor,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";

export type FileChangeItem = {
  id: string;
  path: string;
  oldPath: string | null;
  additions: number | null;
  deletions: number | null;
};

export type FileChangeContent = {
  open: Accessor<boolean>;
  visible: Accessor<boolean>;
  scrollRoot: () => HTMLElement;
  scrollContent: () => HTMLElement;
};

export function FileChanges<T extends FileChangeItem>(props: {
  items: T[];
  visible: boolean;
  children: (item: Accessor<T>, context: FileChangeContent) => JSX.Element;
  headerControls?: (item: Accessor<T>) => JSX.Element;
  headerWrapper?: (item: Accessor<T>, header: () => JSX.Element) => JSX.Element;
  toolbarActions?: JSX.Element;
  empty?: JSX.Element;
}) {
  const { t } = useI18n();
  let scrollRoot!: HTMLDivElement;
  let scrollContent!: HTMLDivElement;
  const [collapsed, setCollapsed] = createSignal(new Set<string>());
  const itemsById = createMemo(
    () => new Map(props.items.map((item) => [item.id, item])),
  );
  const ids = createMemo(() => [...itemsById().keys()]);
  const allOpen = () => ids().every((id) => !collapsed().has(id));
  const totals = createMemo(() =>
    props.items.reduce(
      (sum, item) => ({
        additions: sum.additions + (item.additions ?? 0),
        deletions: sum.deletions + (item.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 },
    ),
  );
  function setOpen(id: string, open: boolean) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          class="size-7 shrink-0"
          disabled={props.items.length === 0}
          aria-label={t(allOpen() ? "git.collapseAll" : "git.expandAll")}
          title={t(allOpen() ? "git.collapseAll" : "git.expandAll")}
          onClick={() => setCollapsed(allOpen() ? new Set(ids()) : new Set())}
        >
          <Show
            when={allOpen()}
            fallback={<ChevronsUpDown class="size-4" aria-hidden="true" />}
          >
            <ChevronsDownUp class="size-4" aria-hidden="true" />
          </Show>
        </Button>
        <span class="min-w-0 flex-1 text-xs text-muted">
          {t("git.files", { count: props.items.length })}
        </span>
        {props.toolbarActions}
        <span role="img" aria-label={t("git.lineTotals", totals())}>
          <ChangeStats {...totals()} />
        </span>
      </div>
      <div ref={scrollRoot} class="min-h-0 min-w-0 flex-1 overflow-auto">
        <div ref={scrollContent} class="space-y-2 p-2">
          <For each={ids()} fallback={props.empty}>
            {(id) => {
              onCleanup(() => setOpen(id, true));
              const item = () => itemsById().get(id) as T;
              const open = () => !collapsed().has(id);
              const name = () => item().path.split("/").at(-1);
              const directory = () =>
                item().path.slice(0, item().path.lastIndexOf("/") + 1);
              const pathLabel = () =>
                item().oldPath
                  ? `${item().oldPath} → ${item().path}`
                  : item().path;
              function Header() {
                return (
                  <div class="flex min-w-0 items-center gap-2 rounded-t-md px-2 py-1">
                    <CollapsibleTrigger
                      class="flex size-6 shrink-0 items-center justify-center rounded hover:bg-panel focus-visible:outline-2 focus-visible:outline-accent"
                      aria-label={t(
                        open() ? "git.collapseFile" : "git.expandFile",
                        { path: item().path },
                      )}
                    >
                      <ChevronDown
                        class="size-3.5 text-muted"
                        classList={{ "-rotate-90": !open() }}
                        aria-hidden="true"
                      />
                    </CollapsibleTrigger>
                    {props.headerControls?.(item)}
                    <span
                      class="flex min-w-0 flex-1 items-baseline gap-2"
                      title={pathLabel()}
                    >
                      <span class="truncate text-xs font-medium">{name()}</span>
                      <Show when={directory()}>
                        <span class="min-w-0 truncate text-xs text-muted">
                          {directory()}
                        </span>
                      </Show>
                    </span>
                    <ChangeStats
                      additions={item().additions}
                      deletions={item().deletions}
                    />
                  </div>
                );
              }
              return (
                <Collapsible
                  open={open()}
                  onOpenChange={(value) => setOpen(id, value)}
                  forceMount
                  class="min-w-0 rounded-md border border-line bg-canvas"
                >
                  {props.headerWrapper ? (
                    props.headerWrapper(item, () => <Header />)
                  ) : (
                    <Header />
                  )}
                  <CollapsibleContent
                    hidden={!open()}
                    class="min-w-0 border-t border-line"
                  >
                    {props.children(item, {
                      open,
                      visible: () => props.visible && open(),
                      scrollRoot: () => scrollRoot,
                      scrollContent: () => scrollContent,
                    })}
                  </CollapsibleContent>
                </Collapsible>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
