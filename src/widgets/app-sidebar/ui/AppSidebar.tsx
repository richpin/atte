import {
  Bot,
  EllipsisVertical,
  FolderClosed,
  FolderOpen,
  Plus,
  Settings,
  SquarePen,
  Trash2,
} from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  AgentIcon,
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
  showErrorToast,
  useSidebar,
} from "shared/ui";
import { createMemo, createSignal, For, Show } from "solid-js";

type AppView = "new-thread" | "thread" | "general" | "agents";

type SidebarThread = {
  id: string;
  title: string;
  workingFolder: string;
  agentId: string;
  status: string;
};

export function AppSidebar(props: {
  view: AppView;
  threads: SidebarThread[];
  selected?: string;
  loading: boolean;
  failed: boolean;
  creating: boolean;
  onRetry: () => void;
  onNewThread: () => void;
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
    setDeleteCandidate(entry);
  }

  async function confirmDelete() {
    const candidate = deleteCandidate();
    if (!candidate || deleting()) return;
    setDeleting(true);
    try {
      await props.onDeleteThread(candidate.id);
      setDeleteCandidate(undefined);
    } catch (cause) {
      showErrorToast(message(cause, "sidebar.deleteFailed"));
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
                  aria-current={
                    props.view === "new-thread" ? "page" : undefined
                  }
                  onClick={props.onNewThread}
                >
                  <SquarePen aria-hidden="true" />
                  <span class="truncate">{t("sidebar.newThread")}</span>
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
                                  const [menuOpen, setMenuOpen] =
                                    createSignal(false);
                                  const title = () =>
                                    content(entry.title) ||
                                    t("common.newThread");
                                  const selected = () =>
                                    props.view === "thread" &&
                                    props.selected === entry.id;

                                  return (
                                    <DropdownMenu
                                      open={menuOpen()}
                                      onOpenChange={setMenuOpen}
                                      placement="right-start"
                                    >
                                      <SidebarMenuSubItem
                                        class="group/menu-item relative"
                                        onContextMenu={(event) => {
                                          event.preventDefault();
                                          setMenuOpen(true);
                                        }}
                                      >
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
                                              {t("sidebar.waitingForApproval")}
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
                                        <DropdownMenuTrigger
                                          as={SidebarMenuAction}
                                          aria-label={t("sidebar.threadMenu", {
                                            name: title(),
                                          })}
                                          showOnHover
                                        >
                                          <EllipsisVertical
                                            aria-hidden="true"
                                            style={{ "stroke-width": "1px" }}
                                          />
                                        </DropdownMenuTrigger>
                                      </SidebarMenuSubItem>
                                      <DropdownMenuContent>
                                        <DropdownMenuItem
                                          class="px-3 py-2 text-danger hover:bg-danger-soft data-[highlighted]:bg-danger-soft"
                                          onSelect={() => requestDelete(entry)}
                                        >
                                          <Trash2
                                            aria-hidden="true"
                                            class="size-3.5"
                                          />
                                          {t("common.delete")}
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
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
                  class="aria-[current=page]:bg-menu-hover aria-[current=page]:font-medium"
                  onSelect={props.onShowGeneral}
                >
                  <Settings aria-hidden="true" class="size-4" />
                  {t("settings.general")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  aria-current={props.view === "agents" ? "page" : undefined}
                  class="aria-[current=page]:bg-menu-hover aria-[current=page]:font-medium"
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

      <Dialog
        open={Boolean(deleteCandidate())}
        onOpenChange={(open) => {
          if (!open && !deleting()) setDeleteCandidate(undefined);
        }}
      >
        <DialogContent role="alertdialog">
          <DialogHeader>
            <DialogTitle>{t("sidebar.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("sidebar.deleteDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              aria-label={t("common.cancel")}
              disabled={deleting()}
              variant="outline"
              onClick={() => setDeleteCandidate(undefined)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={deleting()}
              variant="destructive"
              onClick={() => void confirmDelete()}
            >
              {deleting() ? t("common.deleting") : t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
