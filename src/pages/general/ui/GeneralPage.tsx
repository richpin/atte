import { SegmentedControl } from "@kobalte/core/segmented-control";
import { useI18n } from "shared/i18n";
import {
  isThemePreference,
  type ThemePreference,
  useTheme,
} from "shared/theme";
import { LanguageMenu } from "shared/ui";
import { For } from "solid-js";

const themeOptions: {
  value: ThemePreference;
  label: "theme.system" | "theme.light" | "theme.dark";
}[] = [
  { value: "system", label: "theme.system" },
  { value: "light", label: "theme.light" },
  { value: "dark", label: "theme.dark" },
];

export function GeneralPage() {
  const { t } = useI18n();
  const { preference, setPreference } = useTheme();

  return (
    <main class="h-full min-h-0 overflow-y-auto bg-canvas text-ink">
      <section class="mx-auto max-w-3xl space-y-4 px-6 py-8">
        <div class="flex flex-col items-start justify-between gap-4 rounded-2xl border border-line bg-input-surface p-5 sm:flex-row sm:items-center sm:gap-6">
          <div class="min-w-0 space-y-1">
            <h2 class="font-medium">{t("theme.label")}</h2>
            <p class="text-sm text-muted">{t("settings.themeDescription")}</p>
          </div>
          <SegmentedControl
            aria-label={t("theme.label")}
            value={preference()}
            onChange={(value) => {
              if (isThemePreference(value)) setPreference(value);
            }}
            class="grid shrink-0 grid-cols-3 rounded-lg border border-line bg-canvas p-1"
          >
            <For each={themeOptions}>
              {(option) => (
                <SegmentedControl.Item
                  value={option.value}
                  class="rounded-md px-3 py-1.5 text-center text-xs text-muted transition-colors data-[checked]:bg-ink data-[checked]:text-canvas has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent"
                >
                  <SegmentedControl.ItemInput />
                  <SegmentedControl.ItemLabel>
                    {t(option.label)}
                  </SegmentedControl.ItemLabel>
                </SegmentedControl.Item>
              )}
            </For>
          </SegmentedControl>
        </div>
        <div class="flex flex-col items-start justify-between gap-4 rounded-2xl border border-line bg-input-surface p-5 sm:flex-row sm:items-center sm:gap-6">
          <div class="min-w-0 space-y-1">
            <h2 class="font-medium">{t("language.label")}</h2>
            <p class="text-sm text-muted">
              {t("settings.languageDescription")}
            </p>
          </div>
          <LanguageMenu />
        </div>
      </section>
    </main>
  );
}
