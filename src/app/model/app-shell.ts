import { createFilesManager } from "features/workspace-files";
import {
  createThreadModel,
  inspectWorkingFolder,
  preparedAgents,
  type WorkingMode,
} from "pages/thread";
import { useI18n } from "shared/i18n";
import { showErrorToast } from "shared/ui";
import { createEffect, createResource, createSignal } from "solid-js";
import { createThreadPanelModel } from "widgets/thread-panel";

export type AppView = "new-thread" | "thread" | "general" | "agents";

export function createAppShellModel() {
  const { t } = useI18n();
  const threads = createThreadModel(undefined, showErrorToast);
  const threadPanels = createThreadPanelModel(createFilesManager(t));
  const [view, setView] = createSignal<AppView>("new-thread");
  const [agentsRevision, setAgentsRevision] = createSignal(0);
  const [agentsFailed, setAgentsFailed] = createSignal(false);
  const [selectedAgent, setSelectedAgent] = createSignal("");
  const [selectedFolder, setSelectedFolder] = createSignal<string>();
  const [workingMode, setWorkingMode] = createSignal<WorkingMode>("local");
  const [folderInfo] = createResource(selectedFolder, async (folder) => {
    try {
      return await inspectWorkingFolder(folder);
    } catch {
      return {
        repositoryRoot: null,
        commit: null,
        unavailableReason: "inspectionFailed",
      };
    }
  });
  const worktreeUnavailable = () => folderInfo.loading || !folderInfo()?.commit;

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
    setWorkingMode("local");
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
    if (folder) {
      setSelectedFolder(folder);
      setWorkingMode("local");
    }
  }

  async function startThread() {
    const folder = selectedFolder();
    const agent = agentId();
    if (
      !folder ||
      !agent ||
      agents.loading ||
      agentsFailed() ||
      threads.selecting() ||
      (workingMode() === "worktree" && worktreeUnavailable())
    )
      return;
    await threads.createInFolder(folder, agent, workingMode());
    if (threads.selectedThreadId()) setView("thread");
  }

  async function removeThread(id: string) {
    if (!(await threadPanels.confirmForget(id))) return;
    const selected = threads.selectedThreadId() === id;
    await threads.removeThread(id);
    threadPanels.forget(id);
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
    threadPanels,
    agents: () => agents() ?? [],
    agentsLoading: () => agents.loading,
    agentsFailed,
    agentId,
    selectedFolder,
    workingMode,
    setWorkingMode,
    folderInfo,
    worktreeUnavailable,
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
