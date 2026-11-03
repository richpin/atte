import { useI18n } from "shared/i18n";
import { Button } from "shared/ui";
import { Show } from "solid-js";
import type { AppUpdates } from "../model/updates";

export function AppUpdateSettings(props: { updates: AppUpdates }) {
  const { t } = useI18n();
  const model = () => props.updates;
  return (
    <section
      class="space-y-3 rounded-2xl border border-line bg-input-surface p-5"
      aria-label={t("appUpdates.title")}
    >
      <h2 class="font-medium">{t("appUpdates.title")}</h2>
      <p class="text-sm text-muted" role="status">
        {model().info()?.currentVersion}
        {" · "}
        {model().installed()
          ? t("appUpdates.ready")
          : model().info()?.version
            ? t("appUpdates.available", {
                version: model().info()?.version ?? "",
              })
            : model().info()?.supported
              ? t("appUpdates.current")
              : t("appUpdates.unavailable")}
      </p>
      <Show when={model().info()?.notes}>
        {(notes) => (
          <p class="whitespace-pre-wrap text-sm text-muted">{notes()}</p>
        )}
      </Show>
      <Show when={model().progress()}>
        {(progress) => (
          <p class="text-sm text-muted" role="status">
            {t("appUpdates.downloading")}{" "}
            {progress().total
              ? `${Math.floor((progress().downloaded / (progress().total ?? 1)) * 100)}%`
              : `${Math.floor(progress().downloaded / 1024)} KB`}
          </p>
        )}
      </Show>
      <Show when={model().error()}>
        <p class="text-sm text-danger" role="alert">
          {t("appUpdates.error")}
        </p>
      </Show>
      <div class="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={
            model().busy() ||
            model().installed() ||
            model().info()?.supported === false
          }
          onClick={() => void model().check()}
        >
          {model().busy() && !model().progress()
            ? t("appUpdates.checking")
            : t("appUpdates.check")}
        </Button>
        <Show when={model().info()?.version && !model().installed()}>
          <Button
            variant="outline"
            disabled={model().busy()}
            onClick={() => void model().install()}
          >
            {t("appUpdates.install")}
          </Button>
        </Show>
        <Show when={model().installed()}>
          <Button variant="outline" onClick={() => void model().restart()}>
            {t("appUpdates.restart")}
          </Button>
          <p class="text-sm text-muted">{t("appUpdates.restartHint")}</p>
        </Show>
      </div>
    </section>
  );
}
