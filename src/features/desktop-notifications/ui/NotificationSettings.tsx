import { useI18n } from "shared/i18n";
import {
  Button,
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "shared/ui";
import { For, Show } from "solid-js";
import type { NotificationPreferences } from "../api/notifications";
import type { DesktopNotifications } from "../model/notifications";

const kinds: (keyof NotificationPreferences)[] = ["completion", "permission"];

export function NotificationSettings(props: {
  notifications: DesktopNotifications;
}) {
  const { t } = useI18n();
  const model = () => props.notifications;
  const state = () => model().state();
  return (
    <Show when={state()?.supported || model().error()}>
      <section
        aria-label={t("desktopNotifications.title")}
        class="space-y-4 rounded-2xl border border-line bg-input-surface p-5"
      >
        <div class="space-y-1">
          <h2 class="font-medium">{t("desktopNotifications.title")}</h2>
          <p class="text-sm text-muted">
            {t("desktopNotifications.description")}
          </p>
        </div>
        <For each={kinds}>
          {(kind) => (
            <Switch
              class="flex items-center justify-between gap-4"
              checked={state()?.preferences[kind] ?? true}
              disabled={model().saving() || model().loading() || !state()}
              onChange={(checked) => {
                const preferences = state()?.preferences;
                if (preferences)
                  void model().save({ ...preferences, [kind]: checked });
              }}
            >
              <SwitchLabel>{t(`desktopNotifications.${kind}`)}</SwitchLabel>
              <SwitchControl class="h-4.5 w-8.5 border">
                <SwitchThumb class="size-4 data-[checked]:translate-x-4" />
              </SwitchControl>
            </Switch>
          )}
        </For>
        <Show when={state()}>
          {(current) => (
            <div class="space-y-3 border-line border-t pt-4">
              <p class="text-sm text-muted" role="status">
                {t(
                  `desktopNotifications.authorization.${current().authorization}`,
                )}
              </p>
              <div class="flex flex-wrap gap-2">
                <Show when={current().authorization === "notDetermined"}>
                  <Button
                    variant="outline"
                    onClick={() => void model().requestPermission()}
                  >
                    {t("desktopNotifications.allow")}
                  </Button>
                </Show>
                <Button
                  variant="outline"
                  disabled={current().authorization === "requesting"}
                  onClick={() => void model().openSettings()}
                >
                  {t("desktopNotifications.openSettings")}
                </Button>
              </div>
            </div>
          )}
        </Show>
        <Show when={model().error() || state()?.failure}>
          <div class="space-y-2 text-sm text-danger" role="alert">
            <p>
              {state()?.failure === "unavailable"
                ? t("desktopNotifications.unavailable")
                : t("desktopNotifications.error")}
            </p>
            <Show when={model().error()}>
              <Button
                variant="outline"
                disabled={model().loading()}
                onClick={() => void model().retry()}
              >
                {t("desktopNotifications.retry")}
              </Button>
            </Show>
          </div>
        </Show>
      </section>
    </Show>
  );
}
