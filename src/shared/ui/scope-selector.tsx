import { For, Show } from "solid-js";
import { useI18n } from "../i18n";
import { Button } from "./button";

export function ScopeSelector(props: {
  projects: { folder: string; name: string }[];
  folder: string | undefined;
  disabled?: boolean;
  onChange: (folder: string) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <legend class="sr-only">{t("skills.scope")}</legend>
      <div class="rounded-xl border border-line p-1">
        <Button
          size="sm"
          variant={!props.folder ? "secondary" : "ghost"}
          aria-pressed={!props.folder}
          disabled={props.disabled}
          onClick={() => props.onChange("")}
        >
          {t("skills.global")}
        </Button>
      </div>
      <Show when={props.projects.length > 0}>
        <fieldset class="flex flex-wrap items-center gap-2">
          <legend class="sr-only">{t("skills.projects")}</legend>
          <div class="flex flex-wrap gap-1 rounded-xl border border-line p-1">
            <For each={props.projects}>
              {(entry) => (
                <Button
                  size="sm"
                  variant={
                    props.folder === entry.folder ? "secondary" : "ghost"
                  }
                  aria-pressed={props.folder === entry.folder}
                  aria-label={
                    props.projects.filter((item) => item.name === entry.name)
                      .length > 1
                      ? `${entry.name} · ${entry.folder}`
                      : entry.name
                  }
                  title={entry.folder}
                  disabled={props.disabled}
                  onClick={() => props.onChange(entry.folder)}
                >
                  {entry.name}
                </Button>
              )}
            </For>
          </div>
        </fieldset>
      </Show>
    </fieldset>
  );
}
