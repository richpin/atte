import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Webview } from "@tauri-apps/api/webview";

export type WebTabState = {
  url: string;
  title: string;
  faviconUrl: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export async function createWebview(id: string, threadId: string, url: string) {
  await invoke("create_web_tab", { id, threadId, url });
  try {
    const view = await Webview.getByLabel(`browser-${id}`);
    if (!view) throw new Error("Web tab is unavailable");
    return view;
  } catch (error) {
    await webTabAction(id, "close").catch(() => undefined);
    throw error;
  }
}

export function webTabAction(
  id: string,
  action: "navigate" | "reload" | "back" | "forward" | "close",
  url?: string,
) {
  return invoke<void>("web_tab_action", { id, action, url });
}

export function webTabState(id: string) {
  return invoke<WebTabState>("web_tab_state", { id });
}

export function listenForWebTabs(
  open: (threadId: string, url: string) => void,
) {
  return listen<{ threadId: string; url: string }>(
    "browser-open",
    (event) => open(event.payload.threadId, event.payload.url),
    { target: { kind: "Webview", label: "main" } },
  );
}
