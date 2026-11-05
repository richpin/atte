import type { ThreadPanelModel } from "../model/thread-panel";

export type TabShortcut =
  | "new"
  | "close"
  | "next"
  | "previous"
  | `tab:${number}`;

export function shortcutFromKey(event: KeyboardEvent): TabShortcut | undefined {
  if (event.altKey || event.isComposing) return;
  const key = event.key.toLowerCase();
  if (
    ((event.metaKey && !event.ctrlKey) || (event.ctrlKey && !event.metaKey)) &&
    !event.shiftKey
  ) {
    if (key === "t") return "new";
    if (key === "w") return "close";
    if (/^[1-9]$/.test(key)) return `tab:${key}` as TabShortcut;
  }
  if (event.ctrlKey && !event.metaKey && key === "tab") {
    return event.shiftKey ? "previous" : "next";
  }
  if (event.metaKey && event.shiftKey && !event.ctrlKey) {
    if (key === "]" || event.code === "BracketRight") return "next";
    if (key === "[" || event.code === "BracketLeft") return "previous";
  }
}

export function runTabShortcut(
  shortcut: TabShortcut,
  model: ThreadPanelModel,
  threadId: string | undefined,
  active: boolean,
  closeThread: () => void,
  closeWindow: () => void,
) {
  if (shortcut === "close" && (!active || !threadId)) {
    closeWindow();
    return;
  }
  if (!active || !threadId) return;
  const panel = model.panel(threadId);
  if (shortcut === "new") {
    model.newTab(threadId);
  } else if (shortcut === "close") {
    if (!panel?.open || panel.tabs.length === 0) {
      closeThread();
    } else {
      void model.closeTab(threadId, panel.selectedTabId);
    }
  } else if (panel?.open && panel.tabs.length > 0) {
    const index = panel.tabs.findIndex((tab) => tab.id === panel.selectedTabId);
    if (shortcut === "next" || shortcut === "previous") {
      const step = shortcut === "next" ? 1 : -1;
      const next = (index + step + panel.tabs.length) % panel.tabs.length;
      const tab = panel.tabs[next];
      if (tab) model.selectTab(threadId, tab.id);
    } else {
      const number = Number(shortcut.slice(4));
      const tab = panel.tabs[number === 9 ? panel.tabs.length - 1 : number - 1];
      if (tab) model.selectTab(threadId, tab.id);
    }
  }
}
