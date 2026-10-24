import { useI18n } from "shared/i18n";
import { FileDiff } from "shared/ui";
import { createMemo, createResource, For, Show } from "solid-js";
import { readWorkingFile, type WorkingFile } from "../../api/git-working";
import { prepareCommitPatch } from "../../lib/git-patch";
import { selectionFor, selectWorkingFile } from "../../model/git-working";
import { useGitWorking } from "../../model/use-git-working";

export function WorkingReview(props: { threadId: string; visible: boolean }) {
  const { t } = useI18n();
  const query = useGitWorking(props.threadId, () => props.visible);
  const files = createMemo(
    () =>
      query.data?.files.flatMap((file) => [
        ...(file.staged ? [{ file, side: "staged" as const }] : []),
        ...(file.unstaged ? [{ file, side: "unstaged" as const }] : []),
      ]) ?? [],
  );
  const selected = createMemo(() => selectionFor(props.threadId));
  const current = createMemo(() =>
    files().find(
      (entry) =>
        entry.file.id === selected()?.id && entry.side === selected()?.side,
    ),
  );
  const [result] = createResource(
    () => {
      const entry = current();
      return entry && props.visible
        ? `${entry.file.id}:${entry.side}:${query.dataUpdatedAt}`
        : undefined;
    },
    async () => {
      const entry = current();
      if (!entry) return undefined;
      const response = await readWorkingFile(
        props.threadId,
        entry.file.id,
        entry.side,
      );
      const key = `${entry.file.id}:${entry.side}`;
      if (response.kind !== "text") return { kind: response.kind, key };
      const file: WorkingFile = entry.file;
      const diff = await prepareCommitPatch(
        response.patch,
        {
          path: file.path,
          oldPath: file.oldPath,
          change: file.status,
          oldMode: "",
          newMode: "",
          oldOid: "",
          newOid: "",
        },
        `${file.id}:${entry.side}`,
      );
      return { kind: "text" as const, patch: response.patch, diff, key };
    },
  );
  const stable = createMemo(
    (previous: ReturnType<typeof result> | undefined) => {
      const next = result();
      if (
        previous?.kind === "text" &&
        next?.kind === "text" &&
        previous.key === next.key &&
        previous.patch === next.patch
      )
        return previous;
      return next;
    },
  );
  let scrollRoot!: HTMLDivElement;
  let scrollContent!: HTMLDivElement;
  return (
    <section
      class="flex h-full min-h-0 min-w-0 flex-col"
      aria-label={t("git.workingReview")}
    >
      <header class="shrink-0 border-b border-line px-3 py-3 text-sm font-medium">
        {t("git.workingReview")}
      </header>
      <div class="flex min-h-0 flex-1 flex-col @min-[600px]:flex-row">
        <div class="max-h-44 shrink-0 overflow-auto border-b border-line @min-[600px]:max-h-none @min-[600px]:w-56 @min-[600px]:border-b-0 @min-[600px]:border-r">
          <For each={files()}>
            {(entry) => (
              <button
                type="button"
                class="flex w-full gap-2 px-3 py-2 text-left text-xs hover:bg-panel"
                classList={{
                  "bg-panel":
                    selected()?.id === entry.file.id &&
                    selected()?.side === entry.side,
                }}
                onClick={() =>
                  selectWorkingFile(props.threadId, {
                    id: entry.file.id,
                    side: entry.side,
                  })
                }
              >
                <span class="min-w-0 flex-1 truncate" title={entry.file.path}>
                  {entry.file.path.split("/").at(-1)}
                </span>
                <span class="text-muted">
                  {entry.side === "staged"
                    ? t("git.staged")
                    : t("git.unstaged")}
                </span>
              </button>
            )}
          </For>
        </div>
        <div ref={scrollRoot} class="min-h-0 min-w-0 flex-1 overflow-auto">
          <div ref={scrollContent}>
            <Show
              when={current()}
              fallback={
                <p class="p-4 text-xs text-muted">{t("git.changeGone")}</p>
              }
            >
              {(entry) => (
                <>
                  <p class="border-b border-line px-3 py-3 text-xs text-muted break-all">
                    {entry().file.oldPath ? `${entry().file.oldPath} → ` : ""}
                    {entry().file.path} ·{" "}
                    {entry().side === "staged"
                      ? t("git.staged")
                      : t("git.unstaged")}
                  </p>
                  <Show when={result.loading}>
                    <p role="status" class="p-4 text-xs text-muted">
                      {t("git.loadingDiff")}
                    </p>
                  </Show>
                  <Show when={result.error}>
                    <p role="alert" class="p-4 text-xs text-muted">
                      {t("git.failed")}
                    </p>
                  </Show>
                  <Show when={result.loading ? undefined : stable()} keyed>
                    {(data) => {
                      if (data.kind === "text" && data.diff?.hunks.length) {
                        return (
                          <FileDiff
                            comparison={{ diff: data.diff }}
                            fallback={data.patch}
                            scrollRoot={() => scrollRoot}
                            scrollContent={() => scrollContent}
                            visible={props.visible}
                          />
                        );
                      }
                      return (
                        <p class="p-4 text-xs text-muted">
                          {t(
                            `git.${data.kind === "text" ? "metadataOnly" : data.kind}` as "git.metadataOnly",
                          )}
                        </p>
                      );
                    }}
                  </Show>
                </>
              )}
            </Show>
          </div>
        </div>
      </div>
    </section>
  );
}
