import { AlertDialog } from "@kobalte/core/alert-dialog";
import { ContextMenu } from "@kobalte/core/context-menu";
import {
  Bot,
  EllipsisVertical,
  FolderClosed,
  FolderOpen,
  Plus,
  Settings,
  SquarePen,
} from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  AgentIcon,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
  useSidebar,
} from "shared/ui";
import { createMemo, createSignal, For, Show } from "solid-js";

type AppView = "new-chat" | "thread" | "general" | "agents";

type SidebarThread = {
  id: string;
  title: string;
  workingFolder: string;
  agentId: string;
  status: string;
};

const menuClass =
  "min-w-32 rounded-lg border border-line bg-panel p-1 text-sm text-ink shadow-lg";
const deleteItemClass =
  "rounded px-3 py-2 text-danger outline-none data-[highlighted]:bg-danger-soft";

export function AppSidebar(props: {
  view: AppView;
  threads: SidebarThread[];
  selected?: string;
  loading: boolean;
  failed: boolean;
  creating: boolean;
  onRetry: () => void;
  onNewChat: () => void;
  onSelectThread: (id: string) => void;
  onCreateInProject: (folder: string) => void;
  onDeleteThread: (id: string) => Promise<void>;
  onShowGeneral: () => void;
  onManageAgents: () => void;
}) {
  const { t, message, content } = useI18n();
  const { state, isMobile } = useSidebar();
  const [collapsedProjects, setCollapsedProjects] = createSignal(
    new Set<string>(),
  );
  const [deleteCandidate, setDeleteCandidate] = createSignal<SidebarThread>();
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string>();
  const expanded = () => isMobile() || state() === "expanded";

  const groups = createMemo(() => {
    const folders = new Map<string, SidebarThread[]>();
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

  function toggleProject(folder: string) {
    setCollapsedProjects((previous) => {
      const next = new Set(previous);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  function requestDelete(entry: SidebarThread) {
    setDeleteError(undefined);
    setDeleteCandidate(entry);
  }

  async function confirmDelete() {
    const candidate = deleteCandidate();
    if (!candidate || deleting()) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await props.onDeleteThread(candidate.id);
      setDeleteCandidate(undefined);
    } catch (cause) {
      setDeleteError(message(cause, "sidebar.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Sidebar
        aria-label={t("sidebar.navigation")}
        collapsible="resizable"
        class="border-line"
      >
        <SidebarHeader class="pointer-events-none relative h-12 shrink-0 p-0">
          <div
            data-tauri-drag-region
            class="pointer-events-auto absolute inset-0"
          />
          <Show when={expanded()}>
            <SidebarTrigger
              aria-label={t("sidebar.collapse")}
              class="pointer-events-auto absolute top-1.5 left-[5.5rem]"
            />
          </Show>
        </SidebarHeader>

        <Show when={expanded()}>
          <SidebarContent>
            <SidebarMenu class="px-2">
              <SidebarMenuItem>
                <SidebarMenuButton
                  aria-current={props.view === "new-chat" ? "page" : undefined}
                  onClick={props.onNewChat}
                >
                  <SquarePen aria-hidden="true" />
                  <span class="truncate">{t("sidebar.newChat")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <nav
              aria-label={t("sidebar.threads")}
              class="flex min-h-0 flex-1 flex-col"
            >
              <SidebarGroup class="min-h-0 flex-1">
                <SidebarGroupLabel class="text-sm">
                  {t("sidebar.projects")}
                </SidebarGroupLabel>
                <SidebarGroupContent class="min-h-0 flex-1 overflow-y-auto">
                  <Show when={props.failed}>
                    <div class="space-y-2 px-2 py-1">
                      <p role="alert" class="text-sm">
                        {t("sidebar.loadFailed")}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={props.onRetry}
                      >
                        {t("sidebar.reload")}
                      </Button>
                    </div>
                  </Show>
                  <Show
                    when={
                      !props.loading && !props.threads.length && !props.failed
                    }
                  >
                    <p class="px-2 py-1 text-sm text-muted">
                      {t("sidebar.empty")}
                    </p>
                  </Show>
                  <SidebarMenu>
                    <For each={groups()}>
                      {(group) => (
                        <SidebarMenuItem>
                          <SidebarMenuButton
                            aria-label={t("sidebar.project", {
                              name: group.name,
                            })}
                            aria-expanded={
                              !collapsedProjects().has(group.folder)
                            }
                            onClick={() => toggleProject(group.folder)}
                          >
                            <Show
                              when={!collapsedProjects().has(group.folder)}
                              fallback={<FolderClosed aria-hidden="true" />}
                            >
                              <FolderOpen aria-hidden="true" />
                            </Show>
                            <span>{group.name}</span>
                          </SidebarMenuButton>
                          <SidebarMenuAction
                            aria-label={t("sidebar.newThreadIn", {
                              name: group.name,
                            })}
                            disabled={props.creating}
                            onClick={() =>
                              props.onCreateInProject(group.folder)
                            }
                          >
                            <Plus
                              aria-hidden="true"
                              class="text-muted"
                              size={20}
                            />
                          </SidebarMenuAction>
                          <Show when={!collapsedProjects().has(group.folder)}>
                            <SidebarMenuSub class="mr-0 translate-x-0 pr-0">
                              <For each={group.entries}>
                                {(entry) => {
                                  let row: HTMLDivElement | undefined;
                                  const title = () =>
                                    content(entry.title) ||
                                    t("common.newThread");
                                  const selected = () =>
                                    props.view === "thread" &&
                                    props.selected === entry.id;

                                  return (
                                    <ContextMenu>
                                      <ContextMenu.Trigger
                                        ref={(element) => {
                                          row = element;
                                        }}
                                        class="group/menu-item relative"
                                      >
                                        <SidebarMenuSubItem>
                                          <SidebarMenuSubButton
                                            as="button"
                                            aria-current={
                                              selected() ? "page" : undefined
                                            }
                                            class="h-8 w-full pr-7 text-left"
                                            isActive={selected()}
                                            onClick={() =>
                                              props.onSelectThread(entry.id)
                                            }
                                          >
                                            <AgentIcon
                                              id={entry.agentId}
                                              src={null}
                                              compact
                                            />
                                            <span class="min-w-0 flex-1 truncate">
                                              {title()}
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
                                            <Show
                                              when={
                                                entry.status ===
                                                "waitingForApproval"
                                              }
                                            >
                                              <span class="shrink-0 text-xs text-accent">
                                                {t(
                                                  "sidebar.waitingForApproval",
                                                )}
                                              </span>
                                            </Show>
                                            <Show
                                              when={entry.status === "failed"}
                                            >
                                              <span class="shrink-0 text-xs text-muted">
                                                {t("sidebar.connectionError")}
                                              </span>
                                            </Show>
                                          </SidebarMenuSubButton>
                                          <SidebarMenuAction
                                            aria-label={t(
                                              "sidebar.threadMenu",
                                              { name: title() },
                                            )}
                                            showOnHover
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
                                            <EllipsisVertical
                                              aria-hidden="true"
                                              style={{ "stroke-width": "1px" }}
                                            />
                                          </SidebarMenuAction>
                                        </SidebarMenuSubItem>
                                      </ContextMenu.Trigger>
                                      <ContextMenu.Portal>
                                        <ContextMenu.Content class={menuClass}>
                                          <ContextMenu.Item
                                            class={deleteItemClass}
                                            onSelect={() =>
                                              requestDelete(entry)
                                            }
                                          >
                                            {t("common.delete")}
                                          </ContextMenu.Item>
                                        </ContextMenu.Content>
                                      </ContextMenu.Portal>
                                    </ContextMenu>
                                  );
                                }}
                              </For>
                            </SidebarMenuSub>
                          </Show>
                        </SidebarMenuItem>
                      )}
                    </For>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </nav>
          </SidebarContent>

          <SidebarFooter class="flex items-end border-line border-t">
            <DropdownMenu placement="top-end">
              <DropdownMenuTrigger
                aria-label={t("settings.openMenu")}
                class="grid size-8 place-items-center rounded-md text-muted outline-none hover:bg-canvas hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Settings aria-hidden="true" class="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="w-40">
                <DropdownMenuItem
                  aria-current={props.view === "general" ? "page" : undefined}
                  class="rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-canvas aria-[current=page]:bg-canvas aria-[current=page]:font-medium"
                  onSelect={props.onShowGeneral}
                >
                  <Settings aria-hidden="true" class="size-4" />
                  {t("settings.general")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  aria-current={props.view === "agents" ? "page" : undefined}
                  class="rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-canvas aria-[current=page]:bg-canvas aria-[current=page]:font-medium"
                  onSelect={props.onManageAgents}
                >
                  <Bot aria-hidden="true" class="size-4" />
                  {t("settings.agents")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Show>
      </Sidebar>

      <AlertDialog
        open={Boolean(deleteCandidate())}
        onOpenChange={(open) => {
          if (!open && !deleting()) setDeleteCandidate(undefined);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="fixed inset-0 bg-black/40" />
          <AlertDialog.Content class="fixed top-1/2 left-1/2 w-[min(28rem,90vw)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-2xl border border-line bg-panel p-6 text-ink shadow-xl">
            <AlertDialog.Title class="font-semibold">
              {t("sidebar.deleteTitle")}
            </AlertDialog.Title>
            <AlertDialog.Description class="text-sm text-muted">
              {t("sidebar.deleteDescription")}
            </AlertDialog.Description>
            <Show when={deleteError()}>
              {(error) => (
                <p
                  role="alert"
                  aria-live="assertive"
                  class="text-sm text-danger"
                >
                  {error()}
                </p>
              )}
            </Show>
            <div class="flex justify-end gap-3 text-sm">
              <AlertDialog.CloseButton
                aria-label={t("common.cancel")}
                disabled={deleting()}
                class="rounded-md border border-input px-4 py-2 font-medium ring-offset-background hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
              >
                {t("common.cancel")}
              </AlertDialog.CloseButton>
              <Button
                disabled={deleting()}
                variant="destructive"
                onClick={() => void confirmDelete()}
              >
                {deleting() ? t("common.deleting") : t("common.delete")}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog>
    </>
  );
}
