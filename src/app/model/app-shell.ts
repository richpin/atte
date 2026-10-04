import { createThreadModel, preparedAgents } from "pages/thread";
import { useI18n } from "shared/i18n";
import { showErrorToast } from "shared/ui";
import { createEffect, createResource, createSignal } from "solid-js";

export type AppView = "new-thread" | "thread" | "general" | "agents";

export function createAppShellModel() {
  const { t } = useI18n();
  const threads = createThreadModel(undefined, showErrorToast);
  const [view, setView] = createSignal<AppView>("new-thread");
  const [agentsRevision, setAgentsRevision] = createSignal(0);
  const [agentsFailed, setAgentsFailed] = createSignal(false);
  const [selectedAgent, setSelectedAgent] = createSignal("");
  const [selectedFolder, setSelectedFolder] = createSignal<string>();
  const [agents] = createResource(agentsRevision, async () => {
    try {
      setAgentsFailed(false);
      return await preparedAgents();
    } catch {
      showErrorToast(t("thread.error.agents"));
      setAgentsFailed(true);
      return [];
    }
  });
  const agentId = () =>
    agents()?.some((agent) => agent.id === selectedAgent())
      ? selectedAgent()
      : "";
  const newThreadError = () =>
    threads.error() ?? (agentsFailed() ? t("thread.error.agents") : undefined);

  function showNewThread(folder?: string) {
    threads.startNewThread();
    if (folder !== undefined) setSelectedFolder(folder);
    setView("new-thread");
  }

  async function openThread(id: string) {
    await threads.openThread(id);
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

  async function startThread() {
    const folder = selectedFolder();
    const agent = agentId();
    if (
      !folder ||
      !agent ||
      agents.loading ||
      agentsFailed() ||
      threads.selecting()
    )
      return;
    await threads.createInFolder(folder, agent);
    if (threads.selectedThreadId()) setView("thread");
  }

  async function removeThread(id: string) {
    const selected = threads.selectedThreadId() === id;
    await threads.removeThread(id);
    if (selected) showNewThread();
  }

  function agentsChanged() {
    setAgentsRevision((revision) => revision + 1);
  }

  createEffect(() => {
    if (view() !== "thread") return;
    const id = threads.selectedThreadId();
    if (!id) return;
    const current = threads.thread();
    const completion =
      threads.history().find((entry) => entry.id === id)?.completedTurnId ??
      (current?.id === id ? current.completedTurnId : undefined);
    if (completion) threads.confirmCompletion(id, completion);
  });

  createEffect(() => {
    if (view() === "thread" && !threads.selectedThreadId()) showNewThread();
  });

  return {
    view,
    threads,
    agents: () => agents() ?? [],
    agentsLoading: () => agents.loading,
    agentsFailed,
    agentId,
    selectedFolder,
    newThreadError,
    setSelectedAgent,
    showNewThread,
    openThread,
    showGeneral,
    showAgents,
    selectFolder,
    startThread,
    removeThread,
    agentsChanged,
  };
}
