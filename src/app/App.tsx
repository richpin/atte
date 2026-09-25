import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { AgentAuthenticationProvider } from "features/agent-authentication";
import { AgentManagementPage } from "pages/agent-management";
import { GeneralPage } from "pages/general";
import { NewChatPage } from "pages/new-chat";
import { ThreadPage } from "pages/thread";
import { I18nProvider, useI18n } from "shared/i18n";
import {
  Resizable,
  ResizableHandle,
  ResizablePanel,
  SidebarProvider,
  SidebarTrigger,
  useResizable,
  useSidebar,
} from "shared/ui";
import { onMount, Show } from "solid-js";
import { AppSidebar } from "widgets/app-sidebar";
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
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <AgentAuthenticationProvider>
          <AppShell />
        </AgentAuthenticationProvider>
      </QueryClientProvider>
    </I18nProvider>
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
      threads={threads.history()}
      selected={threads.selectedThreadId()}
      loading={threads.listLoading()}
      failed={threads.listError()}
      creating={
        threads.selecting() || shell.agentsLoading() || shell.agentsFailed()
      }
      onRetry={() => void threads.reloadList()}
      onNewChat={shell.showNewChat}
      onSelectThread={(id) => void shell.openThread(id)}
      onCreateInProject={(folder) => void shell.createInProject(folder)}
      onDeleteThread={shell.removeThread}
      onShowGeneral={shell.showGeneral}
      onManageAgents={shell.showAgents}
    />
  );
}

function ShellContent(props: { shell: AppShellModel }) {
  const shell = props.shell;
  const { threads } = shell;
  const { t, content } = useI18n();
  const { state, isMobile, openMobile } = useSidebar();
  const showSidebarTrigger = () =>
    isMobile() ? !openMobile() : state() === "collapsed";
  const title = () => {
    if (shell.view() === "general") return t("settings.general");
    if (shell.view() === "agents") return t("settings.agents");
    if (shell.view() !== "thread") return "";
    const selected = threads.selectedThreadId();
    const current = threads.thread();
    const value =
      current?.id === selected
        ? current?.title
        : threads.history().find((entry) => entry.id === selected)?.title;
    return content(value ?? null) || t("common.newThread");
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
          <h1 class="relative min-w-0 flex-1 truncate text-left text-sm font-medium">
            {title()}
          </h1>
        </Show>
      </header>
      <div hidden={shell.view() !== "new-chat"} class="min-h-0 flex-1">
        <NewChatPage
          agents={shell.agents()}
          selectedAgent={shell.agentId()}
          loading={shell.agentsLoading()}
          failed={shell.agentsFailed()}
          selecting={threads.selecting()}
          error={shell.newChatError()}
          onSelectAgent={shell.setSelectedAgent}
          onSelectFolder={() => void shell.selectFolder()}
        />
      </div>
      <div hidden={shell.view() !== "thread"} class="min-h-0 flex-1">
        <ThreadPage
          active={shell.view() === "thread"}
          model={threads}
          agents={shell.agents()}
          onManage={shell.showAgents}
        />
      </div>
      <div hidden={shell.view() !== "general"} class="min-h-0 flex-1">
        <GeneralPage />
      </div>
      <div hidden={shell.view() !== "agents"} class="min-h-0 flex-1">
        <AgentManagementPage
          active={shell.view() === "agents"}
          onAgentsChanged={shell.agentsChanged}
        />
      </div>
    </div>
  );
}
