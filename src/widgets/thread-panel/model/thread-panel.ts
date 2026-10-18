import type { Accessor, Component } from "solid-js";
import { createStore, produce } from "solid-js/store";

export const THREAD_PANEL_DEFAULT_WIDTH = 360;
export const THREAD_PANEL_MIN_WIDTH = 320;
export const THREAD_CONTENT_MIN_WIDTH = 320;

export type ThreadPanelContentProps = {
  active: boolean;
  visible: boolean;
};

export type ThreadPanelTab = {
  beforeClose?: () => Promise<boolean>;
  id: string;
  title: Accessor<string>;
  icon?: Component<{ class?: string }>;
  content: Component<ThreadPanelContentProps>;
};

export type ThreadPanelState = {
  threadId: string;
  open: boolean;
  width: number;
  fullWidth: boolean;
  tabs: ThreadPanelTab[];
  selectedTabId: string;
  nextTabNumber: number;
};

export function createThreadPanelModel(
  createNewTab: (number: number, threadId: string) => ThreadPanelTab,
) {
  const [panels, setPanels] = createStore<Record<string, ThreadPanelState>>({});

  function ensure(threadId: string, initialTab?: ThreadPanelTab) {
    if (!panels[threadId]) {
      const tab = initialTab ?? createNewTab(1, threadId);
      setPanels(threadId, {
        threadId,
        open: false,
        width: THREAD_PANEL_DEFAULT_WIDTH,
        fullWidth: false,
        tabs: [tab],
        selectedTabId: tab.id,
        nextTabNumber: initialTab ? 1 : 2,
      });
    }
    return panels[threadId];
  }

  function setOpen(threadId: string, open: boolean) {
    ensure(threadId);
    setPanels(threadId, "open", open);
  }

  function openTab(threadId: string, tab: ThreadPanelTab) {
    const panel = ensure(threadId, tab);
    if (!panel.tabs.some((entry) => entry.id === tab.id)) {
      setPanels(threadId, "tabs", (tabs) => [...tabs, tab]);
    }
    setPanels(threadId, { selectedTabId: tab.id, open: true });
  }

  function newTab(threadId: string) {
    const panel = panels[threadId];
    if (!panel) {
      setOpen(threadId, true);
      return;
    }
    const tab = createNewTab(panel.nextTabNumber, threadId);
    setPanels(threadId, "nextTabNumber", panel.nextTabNumber + 1);
    openTab(threadId, tab);
  }

  function selectTab(threadId: string, tabId: string) {
    if (!panels[threadId]?.tabs.some((tab) => tab.id === tabId)) return;
    setPanels(threadId, "selectedTabId", tabId);
  }

  function closeTab(threadId: string, tabId: string) {
    const tab = panels[threadId]?.tabs.find((entry) => entry.id === tabId);
    if (tab?.beforeClose) {
      return tab.beforeClose().then((proceed) => {
        if (proceed) closeTabNow(threadId, tabId);
        return proceed;
      });
    }
    closeTabNow(threadId, tabId);
    return true;
  }

  function closeTabNow(threadId: string, tabId: string) {
    const panel = panels[threadId];
    if (!panel) return;
    const index = panel.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    if (panel.tabs.length === 1) {
      const tab = createNewTab(1, threadId);
      setPanels(threadId, {
        tabs: [tab],
        selectedTabId: tab.id,
        nextTabNumber: 2,
      });
      return;
    }
    const next = panel.tabs[index + 1] ?? panel.tabs[index - 1];
    if (panel.selectedTabId === tabId) {
      setPanels(threadId, "selectedTabId", next?.id ?? "");
    }
    setPanels(threadId, "tabs", (tabs) =>
      tabs.filter((tab) => tab.id !== tabId),
    );
  }

  function setWidth(threadId: string, width: number) {
    if (!Number.isFinite(width)) return;
    ensure(threadId);
    setPanels(threadId, {
      width: Math.max(THREAD_PANEL_MIN_WIDTH, width),
      fullWidth: false,
    });
  }

  return {
    panels,
    panel: (threadId: string | undefined) =>
      threadId ? panels[threadId] : undefined,
    setOpen,
    openTab,
    newTab,
    selectTab,
    closeTab,
    setWidth,
    setFullWidth: (threadId: string, fullWidth: boolean) => {
      ensure(threadId);
      setPanels(threadId, "fullWidth", fullWidth);
    },
    forget: (threadId: string) =>
      setPanels(
        produce((panels) => {
          delete panels[threadId];
        }),
      ),
  };
}

export type ThreadPanelModel = ReturnType<typeof createThreadPanelModel>;
