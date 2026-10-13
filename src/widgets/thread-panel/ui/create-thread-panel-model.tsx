import { createWebTab } from "features/web-browser";
import { useI18n } from "shared/i18n";
import { createThreadPanelModel as createModel } from "../model/thread-panel";

export function createThreadPanelModel() {
  const { t } = useI18n();
  const model = createModel((number, threadId) =>
    createWebTab(threadId, {
      title: () => t("threadPanel.newTabTitle", { number }),
    }),
  );
  return {
    ...model,
    openWebTab: (threadId: string, url: string) =>
      model.openTab(threadId, createWebTab(threadId, { url })),
  };
}
