import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { AgentAuthenticationProvider } from "features/agent-authentication";
import { AgentManagementPage } from "pages/agent-management";
import { NewChatPage } from "pages/new-chat";
import { ThreadPage } from "pages/thread";
import { I18nProvider, useI18n } from "shared/i18n";
import { SidebarProvider, SidebarTrigger, useSidebar } from "shared/ui";
import { Show } from "solid-js";
import { AppSidebar } from "widgets/app-sidebar";
import { createAppShellModel } from "./model/app-shell";
import "./styles.css";

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
  const { threads } = shell;

  return (
    <SidebarProvider class="relative h-dvh min-h-0 overflow-hidden bg-canvas text-ink">
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
        onManageAgents={shell.showAgents}
      />
      <div class="min-w-0 flex-1 pt-12">
        <div hidden={shell.view() !== "new-chat"} class="h-full">
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
        <div hidden={shell.view() !== "thread"} class="h-full">
          <ThreadPage
            active={shell.view() === "thread"}
            model={threads}
            agents={shell.agents()}
            onManage={shell.showAgents}
          />
        </div>
        <div hidden={shell.view() !== "agents"} class="h-full">
          <AgentManagementPage
            active={shell.view() === "agents"}
            onBack={shell.backFromAgents}
            onAgentsChanged={shell.agentsChanged}
          />
        </div>
      </div>
      <AppTitlebar />
    </SidebarProvider>
  );
}

function AppTitlebar() {
  const { t } = useI18n();
  const { state, isMobile, openMobile } = useSidebar();
  const expanded = () => isMobile() || state() === "expanded";

  return (
    <div class="pointer-events-none absolute inset-x-0 top-0 h-12">
      <div
        data-tauri-drag-region
        class="pointer-events-auto absolute inset-0"
      />
      <Show when={!isMobile() || !openMobile()}>
        <SidebarTrigger
          aria-label={
            !isMobile() && expanded()
              ? t("sidebar.collapse")
              : t("sidebar.expand")
          }
          class="pointer-events-auto absolute top-1.5 left-[5.5rem]"
        />
      </Show>
    </div>
  );
}
