import { AlertDialog } from "@kobalte/core/alert-dialog";
import { ContextMenu } from "@kobalte/core/context-menu";
import { useI18n } from "shared/i18n";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { ThreadMetadata } from "../model/types";

const menuClass =
  "z-30 min-w-32 rounded-lg border border-line bg-panel p-1 text-sm text-ink shadow-lg";
const deleteItemClass =
  "rounded px-3 py-2 text-danger outline-none data-[highlighted]:bg-danger-soft";

export function ThreadSidebar(props: {
  threads: ThreadMetadata[];
  selected?: string;
  loading: boolean;
  failed: boolean;
  creating: boolean;
  onRetry: () => void;
  onSelect: (id: string) => void;
  onCreate: (folder: string) => void;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t, message, content } = useI18n();
  const [collapsed, setCollapsed] = createSignal(new Set<string>());
  const [deleteCandidate, setDeleteCandidate] = createSignal<ThreadMetadata>();
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string>();

  function requestDelete(entry: ThreadMetadata) {
    setDeleteError(undefined);
    setDeleteCandidate(entry);
  }

  async function confirmDelete() {
    const candidate = deleteCandidate();
    if (!candidate || deleting()) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await props.onDelete(candidate.id);
      setDeleteCandidate(undefined);
    } catch (cause) {
      setDeleteError(message(cause, "sidebar.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }
  const groups = createMemo(() => {
    const folders = new Map<string, ThreadMetadata[]>();
    for (const thread of props.threads) {
      const entries = folders.get(thread.workingFolder) ?? [];
      entries.push(thread);
      folders.set(thread.workingFolder, entries);
    }
    return [...folders.keys()].sort().map((folder) => ({
      folder,
      name: folder.split("/").filter(Boolean).at(-1) ?? folder,
      entries: folders.get(folder) ?? [],
    }));
  });
  return (
    <nav
      aria-label={t("sidebar.threads")}
      class="flex w-60 shrink-0 flex-col border-r border-line bg-panel"
    >
      <div class="flex items-center justify-between p-3">
        <h2 class="text-xs font-medium text-muted">{t("sidebar.projects")}</h2>
        <button
          type="button"
          aria-label={t("sidebar.close")}
          class="rounded p-1 text-muted hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          onClick={props.onClose}
        >
          ◧
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <Show when={props.failed}>
          <p role="alert" class="text-sm">
            {t("sidebar.loadFailed")}
          </p>
          <button
            type="button"
            class="focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
            onClick={props.onRetry}
          >
            {t("sidebar.reload")}
          </button>
        </Show>
        <Show when={!props.loading && !props.threads.length && !props.failed}>
          <p class="px-2 text-sm text-muted">{t("sidebar.empty")}</p>
        </Show>
        <For each={groups()}>
          {(group) => (
            <section class="mb-3">
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={t("sidebar.project", { name: group.name })}
                  aria-expanded={!collapsed().has(group.folder)}
                  class="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                  onClick={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(group.folder)) next.delete(group.folder);
                      else next.add(group.folder);
                      return next;
                    })
                  }
                >
                  <span aria-hidden="true">
                    {collapsed().has(group.folder) ? "▸" : "▾"}
                  </span>
                  <span class="truncate">{group.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={t("sidebar.newThreadIn", { name: group.name })}
                  disabled={props.creating}
                  class="shrink-0 rounded px-2 py-1 text-muted hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
                  onClick={() => props.onCreate(group.folder)}
                >
                  +
                </button>
              </div>
              <Show when={!collapsed().has(group.folder)}>
                <For each={group.entries}>
                  {(entry) => {
                    let row: HTMLDivElement | undefined;
                    return (
                      <ContextMenu>
                        <ContextMenu.Trigger
                          ref={(element) => {
                            row = element;
                          }}
                          class="group mb-1 flex w-full items-center rounded-lg hover:bg-canvas focus-within:bg-canvas"
                        >
                          <button
                            type="button"
                            aria-current={
                              props.selected === entry.id ? "page" : undefined
                            }
                            class="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-2 pl-7 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent aria-[current=page]:bg-canvas"
                            onClick={() => props.onSelect(entry.id)}
                          >
                            <span class="min-w-0 flex-1 truncate">
                              {content(entry.title) || t("common.newThread")}
                            </span>
                            <Show
                              when={
                                entry.status === "running" ||
                                entry.status === "cancelling"
                              }
                            >
                              <span class="shrink-0 text-xs text-muted">
                                {t("sidebar.running")}
                              </span>
                            </Show>
                            <Show when={entry.status === "waitingForApproval"}>
                              <span class="shrink-0 text-xs text-accent">
                                {t("sidebar.waitingForApproval")}
                              </span>
                            </Show>
                            <Show when={entry.status === "failed"}>
                              <span class="shrink-0 text-xs text-muted">
                                {t("sidebar.connectionError")}
                              </span>
                            </Show>
                          </button>
                          <button
                            type="button"
                            aria-label={t("sidebar.threadMenu", {
                              name:
                                content(entry.title) || t("common.newThread"),
                            })}
                            class="mr-1 shrink-0 rounded p-1 text-muted opacity-0 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            onClick={(event) => {
                              if (!row) return;
                              const bounds =
                                event.currentTarget.getBoundingClientRect();
                              row.dispatchEvent(
                                new MouseEvent("contextmenu", {
                                  bubbles: true,
                                  cancelable: true,
                                  clientX: bounds.right,
                                  clientY: bounds.bottom,
                                }),
                              );
                            }}
                          >
                            <span aria-hidden="true">⋮</span>
                          </button>
                        </ContextMenu.Trigger>
                        <ContextMenu.Portal>
                          <ContextMenu.Content class={menuClass}>
                            <ContextMenu.Item
                              class={deleteItemClass}
                              onSelect={() => requestDelete(entry)}
                            >
                              {t("common.delete")}
                            </ContextMenu.Item>
                          </ContextMenu.Content>
                        </ContextMenu.Portal>
                      </ContextMenu>
                    );
                  }}
                </For>
              </Show>
            </section>
          )}
        </For>
      </div>
      <AlertDialog
        open={Boolean(deleteCandidate())}
        onOpenChange={(open) => {
          if (!open && !deleting()) setDeleteCandidate(undefined);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="fixed inset-0 z-40 bg-black/40" />
          <AlertDialog.Content class="fixed top-1/2 left-1/2 z-50 w-[min(28rem,90vw)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-2xl border border-line bg-panel p-6 text-ink shadow-xl">
            <AlertDialog.Title class="font-semibold">
              {t("sidebar.deleteTitle")}
            </AlertDialog.Title>
            <AlertDialog.Description class="text-sm text-muted">
              {t("sidebar.deleteDescription")}
            </AlertDialog.Description>
            <Show when={deleteError()}>
              {(message) => (
                <p
                  role="alert"
                  aria-live="assertive"
                  class="text-sm text-danger"
                >
                  {message()}
                </p>
              )}
            </Show>
            <div class="flex justify-end gap-3 text-sm">
              <AlertDialog.CloseButton
                aria-label={t("common.cancel")}
                disabled={deleting()}
                class="rounded-lg border border-line px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
              >
                {t("common.cancel")}
              </AlertDialog.CloseButton>
              <button
                type="button"
                disabled={deleting()}
                class="rounded-lg bg-danger px-4 py-2 text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-danger disabled:opacity-40"
                onClick={() => void confirmDelete()}
              >
                {deleting() ? t("common.deleting") : t("common.delete")}
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog>
    </nav>
  );
}
