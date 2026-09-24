import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { createSignal, For } from "solid-js";
import { type LocalePreference, type TranslationKey, useI18n } from "../i18n";

const options: { value: LocalePreference; label: TranslationKey }[] = [
  { value: "system", label: "language.system" },
  { value: "en", label: "language.english" },
  { value: "ko", label: "language.korean" },
];

export function LanguageMenu() {
  const { preference, setPreference, t } = useI18n();
  const [open, setOpen] = createSignal(false);
  return (
    <DropdownMenu open={open()} onOpenChange={setOpen} placement="bottom-end">
      <DropdownMenu.Trigger
        aria-label={t("language.label")}
        class="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
      >
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
        </svg>
        {t("language.label")}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="min-w-40 rounded-lg border border-line bg-panel p-1 text-sm text-ink shadow-lg">
          <DropdownMenu.RadioGroup
            value={preference()}
            onChange={(value) => {
              if (!isLocalePreference(value)) return;
              setPreference(value);
              setOpen(false);
            }}
          >
            <For each={options}>
              {(option) => (
                <DropdownMenu.RadioItem
                  value={option.value}
                  class="flex items-center gap-2 rounded px-3 py-2 outline-none data-[highlighted]:bg-canvas"
                >
                  <DropdownMenu.ItemIndicator class="w-3 text-accent">
                    ✓
                  </DropdownMenu.ItemIndicator>
                  <span>{t(option.label)}</span>
                </DropdownMenu.RadioItem>
              )}
            </For>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  );
}

function isLocalePreference(value: string): value is LocalePreference {
  return value === "system" || value === "en" || value === "ko";
}
