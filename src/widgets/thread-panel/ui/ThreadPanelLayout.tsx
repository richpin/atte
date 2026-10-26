import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { useI18n } from "shared/i18n";
import { Resizable, ResizableHandle, ResizablePanel } from "shared/ui";
import { createMemo, createSignal, For, type JSX, onMount } from "solid-js";
import {
  THREAD_CONTENT_MIN_WIDTH,
  THREAD_PANEL_MIN_WIDTH,
  type ThreadPanelModel,
} from "../model/thread-panel";
import { ThreadPanel } from "./ThreadPanel";

export function ThreadPanelLayout(props: {
  model: ThreadPanelModel;
  threadId: string | undefined;
  active: boolean;
  panelId: string;
  children: JSX.Element;
}) {
  const { t } = useI18n();
  const [rootWidth, setRootWidth] = createSignal(0);
  let root: HTMLDivElement | undefined;
  const panel = () => props.model.panel(props.threadId);
  const availableWidth = () =>
    Math.max(0, rootWidth() - THREAD_CONTENT_MIN_WIDTH);
  const narrow = () => availableWidth() < THREAD_PANEL_MIN_WIDTH;
  const panelVisible = () =>
    Boolean(props.active && panel()?.open && !narrow());
  const fullWidth = () => panelVisible() && Boolean(panel()?.fullWidth);
  const panelWidth = () => {
    if (!panelVisible()) return 0;
    return fullWidth()
      ? rootWidth()
      : Math.min(panel()?.width ?? rootWidth() / 2, availableWidth());
  };
  const sizes = createMemo(() => {
    const right = rootWidth() > 0 ? panelWidth() / rootWidth() : 0;
    return [1 - right, right];
  });
  const panels = createMemo(() => Object.values(props.model.panels));
  const { observe } = makeResizeObserver((entries) => {
    const entry = entries.find(({ target }) => target === root);
    if (entry) setRootWidth(entry.contentRect.width);
  });

  onMount(() => {
    if (!root) return;
    setRootWidth(root.offsetWidth);
    observe(root);
  });

  function resize(nextSizes: number[]) {
    const threadId = props.threadId;
    const right = nextSizes[1];
    // Corvu also reports controlled sizes and panel registration. Only user
    // changes should replace the remembered width or open state.
    if (
      !props.active ||
      !threadId ||
      rootWidth() === 0 ||
      narrow() ||
      right === undefined ||
      Math.abs(right - sizes()[1]) < 0.000001
    )
      return;
    if (right === 0) {
      props.model.setOpen(threadId, false);
    } else if (right === 1) {
      props.model.setFullWidth(threadId, true);
      props.model.setOpen(threadId, true);
    } else if (!panel()?.open) {
      props.model.setOpen(threadId, true);
    } else {
      props.model.setWidth(threadId, right * rootWidth());
    }
  }

  return (
    <Resizable
      ref={root}
      sizes={sizes()}
      onSizesChange={resize}
      class="min-h-0 min-w-0 overflow-hidden"
    >
      <ResizablePanel
        minSize={narrow() ? 0 : `${THREAD_CONTENT_MIN_WIDTH}px`}
        collapsible
        collapsedSize={0}
        collapseThreshold={0.05}
        hidden={fullWidth()}
        inert={fullWidth()}
        class="min-w-0 overflow-hidden"
      >
        {props.children}
      </ResizablePanel>
      <ResizableHandle
        aria-label={t("threadPanel.resize")}
        disabled={narrow()}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !props.active || !props.threadId) return;
          event.preventDefault();
          props.model.setOpen(props.threadId, !panel()?.open);
        }}
        class="before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 hover:before:bg-line data-[dragging]:before:bg-line"
      />
      <ResizablePanel
        minSize={`${Math.min(THREAD_PANEL_MIN_WIDTH, rootWidth())}px`}
        collapsible
        collapsedSize={0}
        collapseThreshold={0.05}
        class="min-w-0 overflow-hidden"
      >
        <aside
          id={props.panelId}
          aria-label={t("threadPanel.label")}
          hidden={panelWidth() === 0}
          class="h-full min-w-0 border-l border-line"
        >
          <For each={panels()}>
            {(entry) => (
              <div
                hidden={entry.threadId !== props.threadId}
                class="h-full min-h-0"
              >
                <ThreadPanel
                  model={props.model}
                  panel={entry}
                  visible={
                    panelWidth() > 0 && entry.threadId === props.threadId
                  }
                />
              </div>
            )}
          </For>
        </aside>
      </ResizablePanel>
    </Resizable>
  );
}
