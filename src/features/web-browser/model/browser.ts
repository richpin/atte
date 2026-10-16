import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import type { Webview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "shared/i18n";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
  createWebview,
  type WebTabState,
  webTabAction,
  webTabState,
} from "../api/browser";
import { normalizeWebAddress } from "./url";

export type WebBrowserOptions = {
  id: string;
  threadId: string;
  initialUrl?: string;
  visible: boolean;
  onTitle: (title: string) => void;
  onFavicon?: (url: string | null) => void;
};

export function createWebBrowserModel(
  props: WebBrowserOptions & {
    input: () => HTMLInputElement;
    surface: () => HTMLDivElement;
  },
) {
  const { t } = useI18n();
  const [address, setAddress] = createSignal(props.initialUrl ?? "");
  const [state, setState] = createSignal<WebTabState>({
    url: props.initialUrl ?? "",
    title: "",
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  });
  const [error, setError] = createSignal(false);
  const [invalid, setInvalid] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  let view: Webview | undefined;
  let disposed = false;
  let frame: number | undefined;
  let creation: Promise<void> | undefined;
  let surfaceWork = Promise.resolve();
  let lastPlacement = "";
  let placementRevision = 0;
  let retryUrl = props.initialUrl;

  function queuePlacement() {
    placementRevision++;
    if (disposed || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const revision = placementRevision;
      surfaceWork = surfaceWork
        .then(async () => {
          const current = view;
          if (!current || disposed) return;
          if (!props.visible || error()) {
            if (lastPlacement !== "hidden") await current.hide();
            lastPlacement = "hidden";
            return;
          }
          const rect = props.surface().getBoundingClientRect();
          const overlay = [
            ...document.querySelectorAll<HTMLElement>(
              '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
            ),
          ].some(
            (element) =>
              element.getClientRects().length > 0 &&
              !element.closest("[hidden]"),
          );
          const visible = !overlay && rect.width > 0 && rect.height > 0;
          const placement = visible
            ? `${rect.x},${rect.y},${rect.width},${rect.height}`
            : "hidden";
          if (lastPlacement === placement) return;
          if (visible) {
            await current.setPosition(new LogicalPosition(rect.x, rect.y));
            await current.setSize(new LogicalSize(rect.width, rect.height));
            if (disposed || revision !== placementRevision) return;
            await current.show();
          } else {
            await current.hide();
          }
          lastPlacement = placement;
        })
        .catch(() => {
          if (!disposed) setError(true);
        });
    });
  }

  async function create(url: string) {
    if (creation) return creation;
    retryUrl = url;
    setCreating(true);
    setError(false);
    props.onFavicon?.(null);
    creation = (async () => {
      try {
        const created = await createWebview(props.id, props.threadId, url);
        if (disposed) {
          await created.close();
          return;
        }
        view = created;
        setReady(true);
        setState((state) => ({ ...state, url, loading: true }));
        queuePlacement();
      } catch {
        if (!disposed) setError(true);
      } finally {
        creation = undefined;
        if (!disposed) setCreating(false);
      }
    })();
    return creation;
  }

  async function action(
    kind: "navigate" | "reload" | "back" | "forward",
    url?: string,
  ) {
    setError(false);
    props.onFavicon?.(null);
    try {
      await webTabAction(props.id, kind, url);
      if (!disposed) {
        setState((state) => ({ ...state, loading: true }));
        queuePlacement();
      }
    } catch {
      if (!disposed) setError(true);
    }
  }

  async function navigate() {
    if (creating()) return;
    const url = normalizeWebAddress(address());
    setInvalid(!url);
    if (!url) return;
    retryUrl = url;
    setAddress(url);
    if (view) await action("navigate", url);
    else await create(url);
  }

  createEffect(() => {
    props.visible;
    ready();
    error();
    queuePlacement();
  });

  // Read native state only for the visible tab. This also captures SPA URL and
  // history changes without replacing WebKit's delegates.
  createEffect(() => {
    if (!ready() || !props.visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await webTabState(props.id);
        if (cancelled || disposed) return;
        const previous = state();
        setState(next);
        props.onFavicon?.(next.faviconUrl ?? null);
        if (
          next.url &&
          next.url !== previous.url &&
          !(document.hasFocus() && document.activeElement === props.input())
        )
          setAddress(next.url);
        props.onTitle(
          next.title ||
            (next.url ? new URL(next.url).host : t("webBrowser.title")),
        );
      } catch {
        if (!cancelled && !disposed) setError(true);
      }
      if (!cancelled && !disposed) timer = setTimeout(() => void poll(), 500);
    }
    void poll();
    onCleanup(() => {
      cancelled = true;
      clearTimeout(timer);
    });
  });

  createEffect(() => {
    if (!props.visible || !ready()) return;
    const observer = new MutationObserver(queuePlacement);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "data-state"],
    });
    onCleanup(() => observer.disconnect());
  });

  const { observe } = makeResizeObserver(queuePlacement);
  onMount(() => {
    observe(props.surface());
    observe(document.documentElement);
    if (props.initialUrl) void create(props.initialUrl);
    else if (props.visible) props.input().focus();
  });
  onCleanup(() => {
    disposed = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    void surfaceWork.then(() => view?.close()).catch(() => undefined);
  });

  return {
    address,
    setAddress,
    state,
    error,
    invalid,
    setInvalid,
    ready,
    creating,
    navigate,
    action,
    openExternal: () => openUrl(state().url).catch(() => setError(true)),
    restoreAddress: () => {
      if (state().url && !invalid()) setAddress(state().url);
    },
    retry: () => {
      if (view) void action("navigate", retryUrl ?? state().url);
      else if (retryUrl) void create(retryUrl);
    },
  };
}
