import type { PreparedFileChange } from "shared/diff";
import { useI18n } from "shared/i18n";
import { FileDiff } from "shared/ui";
import { createMemo, For, Show } from "solid-js";
import { ChangeStats } from "./ChangeStats";
import { FileChanges } from "./FileChanges";

export function ChangesReview(props: {
  files: PreparedFileChange[];
  visible: boolean;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const items = createMemo(() =>
    props.files.map((file) => ({
      ...file,
      id: file.path,
      oldPath: null,
      additions: file.comparisons.reduce(
        (sum, comparison) => sum + comparison.additions,
        0,
      ),
      deletions: file.comparisons.reduce(
        (sum, comparison) => sum + comparison.deletions,
        0,
      ),
    })),
  );
  return (
    <section
      class="flex h-full min-h-0 min-w-0 flex-col"
      aria-label={t("diff.title")}
    >
      <FileChanges
        items={items()}
        visible={props.visible}
        onOpenFile={
          props.onOpenFile ? (file) => props.onOpenFile?.(file.path) : undefined
        }
      >
        {(file, context) => (
          <For each={file().comparisons}>
            {(comparison, index) => (
              <section class="min-w-0">
                <Show when={file().comparisons.length > 1}>
                  <div class="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs text-muted">
                    <span>{t("diff.edit", { number: index() + 1 })}</span>
                    <ChangeStats
                      additions={comparison.additions}
                      deletions={comparison.deletions}
                    />
                  </div>
                </Show>
                <Show when={context.open()}>
                  <FileDiff
                    comparison={comparison}
                    scrollRoot={context.scrollRoot}
                    scrollContent={context.scrollContent}
                    visible={context.visible()}
                  />
                </Show>
              </section>
            )}
          </For>
        )}
      </FileChanges>
      <footer class="shrink-0 border-t border-line px-4 py-4 text-xs text-muted">
        {t("diff.reportedOnly")}
      </footer>
    </section>
  );
}
