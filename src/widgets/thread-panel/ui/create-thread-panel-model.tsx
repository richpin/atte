import { useI18n } from "shared/i18n";
import { createThreadPanelModel as createModel } from "../model/thread-panel";

export function createThreadPanelModel() {
  const { t } = useI18n();
  return createModel((number) => ({
    id: crypto.randomUUID(),
    title: () => t("threadPanel.newTabTitle", { number }),
    content: () => (
      <div class="grid h-full place-items-center p-6 text-center text-sm text-muted">
        <p>{t("threadPanel.newTabDescription")}</p>
      </div>
    ),
  }));
}
