import { createThreadModel, preparedAgents } from "pages/thread";
import { useI18n } from "shared/i18n";
import { createEffect, createResource, createSignal } from "solid-js";

export type AppView = "new-chat" | "thread" | "general" | "agents";

export function createAppShellModel() {
  const { t } = useI18n();
  const threads = createThreadModel();
  const [view, setView] = createSignal<AppView>("new-chat");
  const [agentsRevision, setAgentsRevision] = createSignal(0);
  const [agentsFailed, setAgentsFailed] = createSignal(false);
  const [selectedAgent, setSelectedAgent] = createSignal("");
  const [selectedFolder, setSelectedFolder] = createSignal<string>();
  const [pendingFolder, setPendingFolder] = createSignal<string>();
  const [agents] = createResource(agentsRevision, async () => {
    try {
      setAgentsFailed(false);
      return await preparedAgents();
    } catch {
      setAgentsFailed(true);
      return [];
    }
  });
  const agentId = () =>
    agents()?.some((agent) => agent.id === selectedAgent())
      ? selectedAgent()
      : agents()?.[0]?.id || "";
  const newChatError = () =>
    threads.error() ?? (agentsFailed() ? t("thread.error.agents") : undefined);

  function showNewChat() {
    threads.startNewChat();
    setSelectedFolder(undefined);
    setPendingFolder(undefined);
    setView("new-chat");
  }

  async function openThread(id: string) {
    await threads.openThread(id);
    setPendingFolder(undefined);
    setView("thread");
  }

  function showAgents() {
    setView("agents");
  }

  function showGeneral() {
    setView("general");
  }

  async function selectFolder() {
    const folder = await threads.selectFolder();
    if (folder) setSelectedFolder(folder);
  }

  async function startChat() {
    const folder = selectedFolder();
    if (!folder || agents.loading || agentsFailed()) return;
    await createInProject(folder);
  }

  async function createInProject(folder: string) {
    if (threads.selecting()) return;
    const agent = agentId();
    if (!agent) {
      setPendingFolder(folder);
      showAgents();
      return;
    }
    setPendingFolder(undefined);
    await threads.createInFolder(folder, agent);
    if (threads.selectedThreadId()) setView("thread");
  }

  async function removeThread(id: string) {
    const selected = threads.selectedThreadId() === id;
    await threads.removeThread(id);
    if (selected) setView("new-chat");
  }

  function agentsChanged() {
    setAgentsRevision((revision) => revision + 1);
  }

  createEffect(() => {
    if (view() === "thread" && !threads.selectedThreadId()) setView("new-chat");
  });

  createEffect(() => {
    const folder = pendingFolder();
    if (view() === "agents" || agents.loading || !agentId() || !folder) return;
    void createInProject(folder);
  });

  return {
    view,
    threads,
    agents: () => agents() ?? [],
    agentsLoading: () => agents.loading,
    agentsFailed,
    agentId,
    selectedFolder,
    newChatError,
    setSelectedAgent,
    showNewChat,
    openThread,
    showGeneral,
    showAgents,
    selectFolder,
    startChat,
    createInProject,
    removeThread,
    agentsChanged,
  };
}
