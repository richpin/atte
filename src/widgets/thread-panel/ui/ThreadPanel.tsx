import * as Tabs from "@kobalte/core/tabs";
import { Globe, Plus, X } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Button } from "shared/ui";
import { createEffect, For } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { ThreadPanelModel, ThreadPanelState } from "../model/thread-panel";

export function ThreadPanel(props: {
  model: ThreadPanelModel;
  panel: ThreadPanelState;
  visible: boolean;
}) {
  const { t } = useI18n();
  const triggers = new Map<string, HTMLButtonElement>();

  function closeTab(tabId: string) {
    const focused = triggers
      .get(tabId)
      ?.parentElement?.contains(document.activeElement);
    props.model.closeTab(props.panel.threadId, tabId);
    triggers.delete(tabId);
    if (focused) {
      triggers.get(props.panel.selectedTabId)?.focus();
    }
  }

  createEffect(() => {
    const selected = props.panel.selectedTabId;
    if (!props.visible) return;
    queueMicrotask(() => {
      triggers.get(selected)?.parentElement?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      });
    });
  });

  return (
    <Tabs.Root
      value={props.panel.selectedTabId}
      onChange={(id) => props.model.selectTab(props.panel.threadId, id)}
      class="flex h-full min-h-0 min-w-0 flex-col bg-canvas text-ink"
    >
      <div class="flex h-10 shrink-0 items-center border-b border-line bg-panel">
        <Tabs.List
          aria-label={t("threadPanel.tabs")}
          class="flex h-full min-w-0 flex-1 overflow-x-auto"
        >
          <For each={props.panel.tabs}>
            {(tab) => (
              <div
                role="presentation"
                class="group/tab flex shrink-0 items-center border-r border-line"
                classList={{
                  "bg-canvas": props.panel.selectedTabId === tab.id,
                }}
              >
                <Tabs.Trigger
                  ref={(element) => triggers.set(tab.id, element)}
                  value={tab.id}
                  title={tab.title()}
                  class="flex h-full min-w-20 max-w-44 items-center gap-2 px-3 text-left text-xs text-muted outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent data-[selected]:text-ink"
                >
                  <span
                    aria-hidden="true"
                    class="flex size-3.5 shrink-0 items-center justify-center"
                  >
                    <Dynamic
                      component={tab.icon ?? Globe}
                      class="size-3.5 shrink-0"
                    />
                  </span>
                  <span class="truncate">{tab.title()}</span>
                </Tabs.Trigger>
                <Button
                  variant="ghost"
                  size="icon"
                  class="mr-1 size-6 shrink-0 text-muted hover:text-ink"
                  aria-label={t("threadPanel.closeTab", { title: tab.title() })}
                  onClick={() => closeTab(tab.id)}
                >
                  <X aria-hidden="true" class="size-3" />
                </Button>
              </div>
            )}
          </For>
        </Tabs.List>
        <Button
          variant="ghost"
          size="icon"
          class="mx-1 size-7 shrink-0 text-muted hover:text-ink"
          aria-label={t("threadPanel.newTab")}
          onClick={() => props.model.newTab(props.panel.threadId)}
        >
          <Plus aria-hidden="true" class="size-4" />
        </Button>
      </div>
      <For each={props.panel.tabs}>
        {(tab) => (
          <Tabs.Content
            value={tab.id}
            forceMount
            hidden={props.panel.selectedTabId !== tab.id}
            class="min-h-0 flex-1 overflow-auto outline-none"
          >
            <Dynamic
              component={tab.content}
              active={props.panel.selectedTabId === tab.id}
              visible={props.visible && props.panel.selectedTabId === tab.id}
            />
          </Tabs.Content>
        )}
      </For>
    </Tabs.Root>
  );
}
