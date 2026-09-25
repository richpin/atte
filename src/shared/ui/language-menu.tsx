import { Globe } from "lucide-solid";
import { createSignal, For } from "solid-js";
import { type LocalePreference, type TranslationKey, useI18n } from "../i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

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
      <DropdownMenuTrigger
        aria-label={t("language.label")}
        class="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
      >
        <Globe aria-hidden="true" class="size-3.5" />
        {t("language.label")}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup
          value={preference()}
          onChange={(value) => {
            if (!isLocalePreference(value)) return;
            setPreference(value);
            setOpen(false);
          }}
        >
          <For each={options}>
            {(option) => (
              <DropdownMenuRadioItem
                value={option.value}
                class="gap-2 px-3 py-2"
              >
                <span>{t(option.label)}</span>
              </DropdownMenuRadioItem>
            )}
          </For>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function isLocalePreference(value: string): value is LocalePreference {
  return value === "system" || value === "en" || value === "ko";
}
