import { ChevronDown, FileCode } from "lucide-solid";
import type { PreparedFileChange } from "shared/diff";
import { useI18n } from "shared/i18n";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FileDiff,
} from "shared/ui";
import { createSignal, For, Show } from "solid-js";
import { ChangeStats } from "./ChangeStats";

function ChangedFile(props: {
  file: PreparedFileChange;
  visible: boolean;
  scrollRoot: () => HTMLElement;
  scrollContent: () => HTMLElement;
}) {
  const { t } = useI18n();
  const [open, setOpen] = createSignal(false);
  const totals = () =>
    props.file.comparisons.reduce(
      (sum, item) => ({
        additions: sum.additions + item.additions,
        deletions: sum.deletions + item.deletions,
      }),
      { additions: 0, deletions: 0 },
    );
  const name = () => props.file.path.split(/[\\/]/).at(-1) || props.file.path;
  return (
    <Collapsible
      open={open()}
      onOpenChange={setOpen}
      class="min-w-0 border-t border-line"
    >
      <CollapsibleTrigger class="flex w-full min-w-0 items-center gap-2 px-3 py-3 text-left hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent">
        <ChevronDown
          aria-hidden="true"
          class="size-3.5 shrink-0 text-muted"
          classList={{ "-rotate-90": !open() }}
        />
        <FileCode aria-hidden="true" class="size-4 shrink-0 text-muted" />
        <span class="min-w-0 flex-1">
          <span class="block break-all text-sm font-medium">{name()}</span>
          <span class="block break-all text-xs text-muted">
            {props.file.path}
          </span>
        </span>
        <ChangeStats {...totals()} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <For each={props.file.comparisons}>
          {(comparison, index) => (
            <section class="min-w-0 border-t border-line">
              <Show when={props.file.comparisons.length > 1}>
                <div class="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted">
                  <span>{t("diff.edit", { number: index() + 1 })}</span>
                  <ChangeStats
                    additions={comparison.additions}
                    deletions={comparison.deletions}
                  />
                </div>
              </Show>
              <FileDiff
                comparison={comparison}
                scrollRoot={props.scrollRoot}
                scrollContent={props.scrollContent}
                visible={props.visible && open()}
              />
            </section>
          )}
        </For>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ChangesReview(props: {
  files: PreparedFileChange[];
  visible: boolean;
}) {
  const { t } = useI18n();
  let scrollRoot!: HTMLElement;
  let scrollContent!: HTMLDivElement;
  const totals = () =>
    props.files
      .flatMap((file) => file.comparisons)
      .reduce(
        (sum, item) => ({
          additions: sum.additions + item.additions,
          deletions: sum.deletions + item.deletions,
        }),
        { additions: 0, deletions: 0 },
      );
  return (
    <section
      ref={scrollRoot}
      class="h-full min-w-0 overflow-auto"
      aria-label={t("diff.title")}
    >
      <div ref={scrollContent}>
        <header class="flex flex-wrap items-center justify-between gap-3 px-4 py-5">
          <div>
            <h2 class="text-base font-semibold">{t("diff.title")}</h2>
            <p class="mt-1 text-xs text-muted">
              {t("diff.files", { count: props.files.length })}
            </p>
          </div>
          <ChangeStats {...totals()} />
        </header>
        <For each={props.files}>
          {(file) => (
            <ChangedFile
              file={file}
              visible={props.visible}
              scrollRoot={() => scrollRoot}
              scrollContent={() => scrollContent}
            />
          )}
        </For>
        <p class="border-t border-line px-4 py-4 text-xs text-muted">
          {t("diff.reportedOnly")}
        </p>
      </div>
    </section>
  );
}
