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
    <Show when={state()?.supported}>
      <section
        aria-label={t("desktopNotifications.title")}
        class="space-y-4 rounded-2xl border border-line bg-input-surface p-5"
      >
        <div class="space-y-1">
          <div class="flex items-center justify-between gap-4">
            <h2 class="font-medium">{t("desktopNotifications.title")}</h2>
            <Button
              variant="outline"
              size="sm"
              class="shrink-0"
              disabled={state()?.authorization === "requesting"}
              onClick={() => void model().openSettings()}
            >
              {t("desktopNotifications.openSettings")}
            </Button>
          </div>
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
      </section>
    </Show>
  );
}
