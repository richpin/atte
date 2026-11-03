import { useI18n } from "shared/i18n";
import { Button } from "shared/ui";
import { Show } from "solid-js";
import type { AppUpdates } from "../model/updates";

export function AppUpdateSettings(props: { updates: AppUpdates }) {
  const { t } = useI18n();
  const model = () => props.updates;
  return (
    <Show when={model().info() || model().installed()}>
      <section
        class="space-y-3 rounded-2xl border border-line bg-input-surface p-5"
        aria-label={t("appUpdates.title")}
      >
        <div class="flex items-center justify-between gap-4">
          <h2 class="font-medium">{t("appUpdates.title")}</h2>
          <Button
            variant="outline"
            size="sm"
            disabled={model().busy()}
            onClick={() =>
              void (model().installed()
                ? model().restart()
                : model().info()?.version
                  ? model().install()
                  : model().check())
            }
          >
            {model().installed()
              ? t("appUpdates.restart")
              : model().busy() && !model().progress()
                ? t("appUpdates.checking")
                : model().info()?.version
                  ? t("appUpdates.install")
                  : t("appUpdates.check")}
          </Button>
        </div>
        <div
          class="flex flex-wrap items-baseline gap-x-3 gap-y-1"
          role="status"
        >
          <span class="text-base font-medium text-muted">
            {model().info()?.currentVersion}
          </span>
          <span class="text-sm text-muted">
            {t("appUpdates.latestVersion", {
              version:
                model().info()?.version ?? model().info()?.currentVersion ?? "",
            })}
          </span>
        </div>
        <Show when={model().installed()}>
          <p class="text-sm text-muted">{t("appUpdates.ready")}</p>
        </Show>
        <Show when={model().installed() ? null : model().info()?.version}>
          {(version) => (
            <p class="text-sm text-muted">
              {t("appUpdates.available", { version: version() })}
            </p>
          )}
        </Show>
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
          <Show when={model().installed()}>
            <p class="text-sm text-muted">{t("appUpdates.restartHint")}</p>
          </Show>
        </div>
      </section>
    </Show>
  );
}
