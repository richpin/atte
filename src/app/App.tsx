import * as ToggleButtonPrimitive from "@kobalte/core/toggle-button";
import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { isTauri } from "@tauri-apps/api/core";
import { AgentAuthenticationProvider } from "features/agent-authentication";
import { OpenWorkingFolderMenu } from "features/open-working-folder";
import { listenForWebTabs } from "features/web-browser";
import {
  Bot,
  Ellipsis,
  List,
  PanelRight,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  SquarePen,
} from "lucide-solid";
import { AgentManagementPage } from "pages/agent-management";
import { GeneralPage } from "pages/general";
import { NewThreadPage } from "pages/new-thread";
import { SkillsPage } from "pages/skills";
import { ThreadPage } from "pages/thread";
import { I18nProvider, useI18n } from "shared/i18n";
import { ThemeProvider } from "shared/theme";
import {
  AgentIcon,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Resizable,
  ResizableHandle,
  ResizablePanel,
  SidebarProvider,
  SidebarTrigger,
  ToastHost,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useResizable,
  useSidebar,
  WebLinkProvider,
} from "shared/ui";
import {
  type ComponentProps,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { AppSidebar } from "widgets/app-sidebar";
import { ThreadPanelLayout } from "widgets/thread-panel";
import { createAppShellModel } from "./model/app-shell";
import "./styles.css";

const SIDEBAR_DEFAULT_WIDTH = 256;
const SIDEBAR_MIN_WIDTH = 224;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_SIZE = "256px";
const SIDEBAR_MIN_SIZE = "224px";
const SIDEBAR_MAX_SIZE = "480px";
const CONTENT_MIN_SIZE = "320px";

export default function App() {
  const queryClient = new QueryClient();
  return (
    <ThemeProvider>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <AgentAuthenticationProvider>
            <AppShell />
            <ToastHost />
          </AgentAuthenticationProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

function AppShell() {
  const shell = createAppShellModel();
  let resizableRoot: HTMLDivElement | undefined;

  return (
    <Resizable
      ref={resizableRoot}
      class="relative h-dvh min-h-0 overflow-hidden bg-canvas text-ink"
    >
      <ResizableAppShell root={() => resizableRoot} shell={shell} />
      <shell.threadPanels.Guard />
    </Resizable>
  );
}

type AppShellModel = ReturnType<typeof createAppShellModel>;

function ResizableAppShell(props: {
  root: () => HTMLDivElement | undefined;
  shell: AppShellModel;
}) {
  const resizable = useResizable();
  let collapsed = false;
  let initialized = false;
  let sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
  const open = () => (resizable.sizes()[0] ?? 1) > 0;

  const { observe } = makeResizeObserver((entries) => {
    const root = props.root();
    if (!initialized || !root || !entries.some(({ target }) => target === root))
      return;
    queueMicrotask(() => {
      if ((resizable.sizes()[0] ?? 0) > 0) {
        resizable.resize(0, `${sidebarWidth}px`, "following");
      }
    });
  });

  onMount(() => {
    const root = props.root();
    if (!root) return;
    observe(root);
    queueMicrotask(() => {
      initialized = true;
      resizable.resize(0, SIDEBAR_DEFAULT_SIZE, "following");
    });
  });

  function rememberSidebarWidth(size: number) {
    const rootWidth = props.root()?.offsetWidth ?? 0;
    if (!initialized || rootWidth === 0) return;
    if (size === 0) {
      collapsed = true;
      return;
    }
    if (collapsed) {
      collapsed = false;
      queueMicrotask(() =>
        resizable.resize(0, `${sidebarWidth}px`, "following"),
      );
      return;
    }
    sidebarWidth = Math.min(
      SIDEBAR_MAX_WIDTH,
      Math.max(SIDEBAR_MIN_WIDTH, size * rootWidth),
    );
  }

  function setOpen(next: boolean) {
    if (next) {
      const previousWidth = sidebarWidth;
      resizable.expand(0, "following");
      resizable.resize(0, `${previousWidth}px`, "following");
    } else {
      resizable.collapse(0, "following");
    }
  }

  return (
    <SidebarProvider
      class="app-resizable relative size-full min-h-0 overflow-hidden"
      forceDesktop
      open={open()}
      onOpenChange={setOpen}
    >
      <AppLayout onSidebarResize={rememberSidebarWidth} shell={props.shell} />
    </SidebarProvider>
  );
}

function AppLayout(props: {
  onSidebarResize: (size: number) => void;
  shell: AppShellModel;
}) {
  const { t } = useI18n();

  return (
    <>
      <ResizablePanel
        minSize={SIDEBAR_MIN_SIZE}
        maxSize={SIDEBAR_MAX_SIZE}
        onResize={props.onSidebarResize}
        collapsible
        collapsedSize={0}
        collapseThreshold={0.05}
        class="min-w-56 max-w-[480px] overflow-hidden bg-sidebar data-[collapsed]:min-w-0"
      >
        <ShellSidebar shell={props.shell} />
      </ResizablePanel>
      <ResizableHandle
        aria-label={t("sidebar.resize")}
        class="before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 hover:before:bg-sidebar-border data-[dragging]:before:bg-sidebar-border"
      />
      <ResizablePanel
        minSize={CONTENT_MIN_SIZE}
        class="min-w-0 overflow-hidden"
      >
        <ShellContent shell={props.shell} />
      </ResizablePanel>
    </>
  );
}

function ShellSidebar(props: { shell: AppShellModel }) {
  const shell = props.shell;
  const { threads } = shell;

  return (
    <AppSidebar
      view={shell.view()}
      projects={shell.projects()}
      threads={threads.history().map((entry) => ({
        ...entry,
        subscriptionFailed: threads.subscriptionFailedFor(entry.id),
        unconfirmed: Boolean(
          entry.completedTurnId &&
            shell.notifications.state()?.confirmedCompletions[entry.id] !==
              entry.completedTurnId,
        ),
      }))}
      selected={threads.selectedThreadId()}
      loading={threads.listLoading()}
      failed={threads.listError()}
      creating={threads.selecting()}
      onRetry={() => void threads.reloadList()}
      onNewThread={() => shell.showNewThread()}
      onSelectThread={(id) => void shell.openThread(id)}
      onNewThreadInProject={(folder) => shell.showNewThread(folder)}
      onDeleteThread={shell.removeThread}
      onRenameThread={threads.renameThread}
      onShowGeneral={shell.showGeneral}
      onManageAgents={shell.showAgents}
      onManageSkills={shell.showSkills}
    />
  );
}

function ShellContent(props: { shell: AppShellModel }) {
  const shell = props.shell;
  const { threads } = shell;
  const { t, content } = useI18n();
  const { state, isMobile, openMobile } = useSidebar();
  const [showInfoCard, setShowInfoCard] = createSignal(true);
  const [findRequest, setFindRequest] = createSignal(0);
  const [skillsVisited, setSkillsVisited] = createSignal(false);
  createEffect(() => {
    if (props.shell.view() === "skills") setSkillsVisited(true);
  });
  let findSelected = false;
  const threadPanelId = createUniqueId();
  onMount(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForWebTabs((threadId, url) => {
      if (threads.history().some((thread) => thread.id === threadId))
        shell.threadPanels.openWebTab(threadId, url);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    onCleanup(() => {
      disposed = true;
      unlisten?.();
    });
  });
  const panelOpen = () =>
    shell.threadPanels.panel(threads.selectedThreadId())?.open ?? false;
  const panelToggleLabel = () =>
    t(panelOpen() ? "threadPanel.collapse" : "threadPanel.expand");
  const showSidebarTrigger = () =>
    isMobile() ? !openMobile() : state() === "collapsed";
  const title = () => {
    if (shell.view() === "general") return t("settings.general");
    if (shell.view() === "agents") return t("settings.agents");
    if (shell.view() === "skills") return t("settings.skills");
    if (shell.view() !== "thread") return "";
    const selected = threads.selectedThreadId();
    const current = threads.thread();
    const value =
      current?.id === selected
        ? current?.title
        : threads.history().find((entry) => entry.id === selected)?.title;
    return content(value ?? null) || t("common.newThread");
  };
  const threadAgentId = () => {
    if (shell.view() !== "thread") return;
    const selected = threads.selectedThreadId();
    const current = threads.thread();
    return current && current.id === selected
      ? current.agentId
      : threads.history().find((entry) => entry.id === selected)?.agentId;
  };

  return (
    <div class="flex h-full min-w-0 flex-1 flex-col">
      <header
        class="pointer-events-none relative flex h-12 shrink-0 items-center gap-4 px-6"
        classList={{
          "pl-32": showSidebarTrigger(),
          "border-b border-line": shell.view() === "thread",
        }}
      >
        <div
          data-tauri-drag-region
          class="pointer-events-auto absolute inset-0"
          classList={{ "left-32": showSidebarTrigger() }}
        />
        <Show when={showSidebarTrigger()}>
          <SidebarTrigger
            aria-label={t("sidebar.expand")}
            class="pointer-events-auto absolute top-1.5 left-[5.5rem]"
          />
        </Show>
        <Show when={title()}>
          <h1 class="relative flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium">
            <Show when={threadAgentId()}>
              {(agentId) => <AgentIcon id={agentId()} src={null} compact />}
            </Show>
            <Show when={shell.view() === "general"}>
              <Settings aria-hidden="true" class="size-4" />
            </Show>
            <Show when={shell.view() === "agents"}>
              <Bot aria-hidden="true" class="size-4" />
            </Show>
            <Show when={shell.view() === "skills"}>
              <Sparkles aria-hidden="true" class="size-4" />
            </Show>
            <span class="truncate">{title()}</span>
          </h1>
        </Show>
        <Show when={shell.view() === "thread" && threads.selectedThreadId()}>
          <div class="relative flex shrink-0 items-center gap-1">
            <Tooltip placement="bottom">
              <TooltipTrigger
                as={Button}
                variant="ghost"
                size="icon"
                aria-label={panelToggleLabel()}
                aria-expanded={panelOpen()}
                aria-controls={threadPanelId}
                class="pointer-events-auto relative size-7 shrink-0 text-muted hover:bg-menu focus-visible:ring-1 focus-visible:ring-line focus-visible:ring-offset-0"
                classList={{ "bg-menu text-ink": panelOpen() }}
                onClick={() => {
                  const id = threads.selectedThreadId();
                  if (id) shell.threadPanels.setOpen(id, !panelOpen());
                }}
              >
                <PanelRight aria-hidden="true" class="size-4" />
              </TooltipTrigger>
              <TooltipContent class="border-0 bg-menu text-ink">
                {panelToggleLabel()}
              </TooltipContent>
            </Tooltip>
            <Tooltip placement="bottom">
              <TooltipTrigger
                aria-label={t("thread.information")}
                as={(triggerProps: ComponentProps<"button">) => (
                  <ToggleButtonPrimitive.Root
                    as={Button}
                    {...triggerProps}
                    pressed={showInfoCard()}
                    onChange={setShowInfoCard}
                    variant="ghost"
                    size="icon"
                    class="pointer-events-auto relative size-7 shrink-0 text-muted hover:bg-menu focus-visible:ring-1 focus-visible:ring-line focus-visible:ring-offset-0 data-[pressed]:bg-menu data-[pressed]:text-ink"
                  >
                    <List aria-hidden="true" class="size-4" />
                  </ToggleButtonPrimitive.Root>
                )}
              />
              <TooltipContent class="border-0 bg-menu text-ink">
                {t("thread.information")}
              </TooltipContent>
            </Tooltip>
            <DropdownMenu placement="bottom-end">
              <DropdownMenuTrigger
                aria-label={t("thread.menu")}
                class="pointer-events-auto relative grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-menu hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
              >
                <Ellipsis aria-hidden="true" class="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                onCloseAutoFocus={() => {
                  if (!findSelected) return;
                  findSelected = false;
                  // Open after the menu has restored focus to its trigger.
                  queueMicrotask(() => setFindRequest((value) => value + 1));
                }}
              >
                <DropdownMenuItem
                  onSelect={() => {
                    findSelected = true;
                  }}
                >
                  <Search aria-hidden="true" class="size-4" />
                  {t("thread.find.menuLabel")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!threads.canReconnect()}
                  onSelect={() => void threads.reconnect()}
                >
                  <RotateCcw aria-hidden="true" class="size-4" />
                  {t("thread.reconnect")}
                </DropdownMenuItem>
                <OpenWorkingFolderMenu threadId={threads.selectedThreadId()} />
                <Show when={threads.thread()?.worktree}>
                  <DropdownMenuItem
                    onSelect={() => {
                      const id = threads.selectedThreadId();
                      if (id) shell.showNewThreadInWorktree(id);
                    }}
                  >
                    <SquarePen aria-hidden="true" class="size-4" />
                    {t("thread.newInWorktree")}
                  </DropdownMenuItem>
                </Show>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Show>
      </header>
      <div hidden={shell.view() !== "new-thread"} class="min-h-0 flex-1">
        <NewThreadPage
          agents={shell.agents()}
          selectedAgent={shell.agentId()}
          selectedFolder={shell.selectedFolder()}
          fixedWorkingFolder={Boolean(shell.existingWorktreeSource())}
          workingMode={shell.workingMode()}
          onSelectWorkingMode={shell.setWorkingMode}
          worktreeUnavailable={shell.worktreeUnavailable()}
          loading={shell.agentsLoading()}
          failed={shell.agentsFailed()}
          selecting={threads.selecting()}
          onSelectAgent={shell.setSelectedAgent}
          onSelectFolder={() => void shell.selectFolder()}
          onStart={() => void shell.startThread()}
          onManageAgents={shell.showAgents}
        />
      </div>
      <div hidden={shell.view() !== "thread"} class="min-h-0 flex-1">
        <ThreadPanelLayout
          model={shell.threadPanels}
          threadId={threads.selectedThreadId()}
          active={shell.view() === "thread"}
          panelId={threadPanelId}
        >
          <WebLinkProvider
            onOpen={(url) => {
              const id = threads.selectedThreadId();
              if (id) shell.threadPanels.openWebTab(id, url);
            }}
          >
            <ThreadPage
              onOpenFile={(path) => {
                const id = threads.selectedThreadId();
                if (id) shell.threadPanels.openFile(id, path);
              }}
              onOpenChanges={(turnId, files) => {
                const id = threads.selectedThreadId();
                if (id) shell.threadPanels.openChangesTab(id, turnId, files);
              }}
              active={shell.view() === "thread"}
              showInfoCard={showInfoCard()}
              onCloseInfoCard={() => setShowInfoCard(false)}
              findRequest={findRequest()}
              model={threads}
              agents={shell.agents()}
              onManage={shell.showAgents}
            />
          </WebLinkProvider>
        </ThreadPanelLayout>
      </div>
      <div hidden={shell.view() !== "general"} class="min-h-0 flex-1">
        <GeneralPage notifications={shell.notifications} />
      </div>
      <div hidden={shell.view() !== "agents"} class="min-h-0 flex-1">
        <AgentManagementPage
          active={shell.view() === "agents"}
          onAgentsChanged={shell.agentsChanged}
        />
      </div>
      <div hidden={shell.view() !== "skills"} class="min-h-0 flex-1">
        <Show when={skillsVisited()}>
          <SkillsPage
            active={shell.view() === "skills"}
            projects={shell.projects()}
          />
        </Show>
      </div>
    </div>
  );
}
