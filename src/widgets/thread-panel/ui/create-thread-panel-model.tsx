import { ChangesReview } from "features/review-changes";
import { createWebTab } from "features/web-browser";
import { FileDiff } from "lucide-solid";
import type { PreparedFileChange } from "shared/diff";
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
    openChangesTab: (
      threadId: string,
      turnId: string,
      files: PreparedFileChange[],
    ) => {
      model.openTab(threadId, {
        id: `changes:${turnId}`,
        title: () => t("diff.tabTitle"),
        icon: FileDiff,
        content: (props) => (
          <ChangesReview files={files} visible={props.visible} />
        ),
      });
    },
  };
}
