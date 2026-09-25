import { useI18n } from "shared/i18n";
import { LanguageMenu } from "shared/ui";

export function GeneralPage() {
  const { t } = useI18n();

  return (
    <main class="h-full min-h-0 overflow-y-auto bg-canvas text-ink">
      <section class="mx-auto max-w-3xl px-6 py-8">
        <div class="flex flex-col items-start justify-between gap-4 rounded-2xl border border-line bg-panel p-5 sm:flex-row sm:items-center sm:gap-6">
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
