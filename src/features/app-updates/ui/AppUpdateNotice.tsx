import { X } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Button } from "shared/ui";
import { createSignal, Show } from "solid-js";
import type { AppUpdates } from "../model/updates";

export function AppUpdateNotice(props: { updates: AppUpdates }) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = createSignal(false);
  const model = () => props.updates;

  return (
    <Show
      when={!dismissed() && (model().info()?.version || model().installed())}
    >
      <aside
        role="status"
        aria-label={t("appUpdates.title")}
        class="fixed right-4 bottom-4 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-menu p-4 text-sm text-ink shadow-lg"
      >
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1 space-y-2">
            <p class="font-medium">{t("appUpdates.title")}</p>
            <p class="text-muted">
              {model().installed()
                ? t("appUpdates.ready")
                : t("appUpdates.available", {
                    version: model().info()?.version ?? "",
                  })}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("notifications.close")}
            class="shrink-0 rounded text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => setDismissed(true)}
          >
            <X aria-hidden="true" class="size-4" />
          </button>
        </div>
        <Show when={model().progress()}>
          {(progress) => (
            <p class="mt-3 text-muted">
              {t("appUpdates.downloading")}{" "}
              {progress().total
                ? `${Math.floor((progress().downloaded / (progress().total ?? 1)) * 100)}%`
                : `${Math.floor(progress().downloaded / 1024)} KB`}
            </p>
          )}
        </Show>
        <Show when={model().error()}>
          <p class="mt-3 text-danger" role="alert">
            {t("appUpdates.error")}
          </p>
        </Show>
        <div class="mt-3 flex justify-end">
          <Show
            when={model().installed()}
            fallback={
              <Button
                variant="outline"
                size="sm"
                disabled={model().busy()}
                onClick={() => void model().install()}
              >
                {t("appUpdates.install")}
              </Button>
            }
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => void model().restart()}
            >
              {t("appUpdates.restart")}
            </Button>
          </Show>
        </div>
      </aside>
    </Show>
  );
}
