import { type FileChangeContent, FileChanges } from "features/review-changes";
import { GitCommitHorizontal } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Button, FileDiff } from "shared/ui";
import { createMemo, createResource, Match, Show, Switch } from "solid-js";
import {
  type ChangedFile,
  readCommit,
  readCommitFile,
} from "../../api/git-history";
import { prepareCommitPatch } from "../../lib/git-patch";

function changeColor(change: string) {
  switch (change[0]) {
    case "A":
      return "text-response-success";
    case "M":
    case "T":
      return "text-response-warning";
    case "D":
    case "U":
    case "B":
      return "text-danger";
    case "R":
    case "C":
      return "text-response-info";
    default:
      return "text-muted";
  }
}

function CommitFile(props: {
  threadId: string;
  oid: string;
  file: ChangedFile;
  index: number;
  context: FileChangeContent;
}) {
  const { t } = useI18n();
  const [result, { refetch }] = createResource(async () => {
    const response = await readCommitFile(
      props.threadId,
      props.oid,
      props.index,
    );
    if (response.kind !== "text") return { kind: response.kind };
    const diff = await prepareCommitPatch(
      response.patch,
      props.file,
      `${props.oid}:${props.index}`,
    );
    return { kind: "text" as const, patch: response.patch, diff };
  });
  return (
    <div class="min-w-0">
      <Switch>
        <Match when={result.loading}>
          <p role="status" class="p-4 text-xs text-muted">
            {t("git.loadingDiff")}
          </p>
        </Match>
        <Match when={result.error}>
          <div role="alert" class="space-y-3 p-4 text-xs text-muted">
            <p>{t("git.failed")}</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              {t("common.retry")}
            </Button>
          </div>
        </Match>
        <Match when={!result.error && result()}>
          {(loaded) => {
            const data = loaded();
            return data.kind === "text" ? (
              <Show
                when={data.diff?.hunks.length ? data.diff : undefined}
                fallback={
                  <p class="p-4 text-xs text-muted">{t("git.metadataOnly")}</p>
                }
              >
                {(diff) => (
                  <Show when={props.context.open()}>
                    <FileDiff
                      comparison={{ diff: diff() }}
                      fallback={data.patch}
                      scrollRoot={props.context.scrollRoot}
                      scrollContent={props.context.scrollContent}
                      visible={props.context.visible()}
                    />
                  </Show>
                )}
              </Show>
            ) : (
              <p class="p-4 text-xs text-muted">
                {t(
                  `git.${data.kind}` as
                    | "git.binary"
                    | "git.tooLarge"
                    | "git.unsupported"
                    | "git.submodule",
                )}
              </p>
            );
          }}
        </Match>
      </Switch>
    </div>
  );
}

export function CommitReview(props: {
  threadId: string;
  oid: string;
  visible: boolean;
}) {
  const { t, locale } = useI18n();
  const [details, { refetch }] = createResource(
    () => props.oid,
    (oid) => readCommit(props.threadId, oid),
  );
  const items = createMemo(() =>
    (details.error ? [] : (details()?.files ?? [])).map((file, index) => ({
      ...file,
      id: `${details()?.commit.oid}:${index}`,
      index,
    })),
  );
  return (
    <section
      class="@container flex h-full min-h-0 flex-col"
      aria-label={t("git.commitChanges")}
    >
      <Show when={details.loading}>
        <p role="status" class="p-4 text-xs text-muted">
          {t("git.loading")}
        </p>
      </Show>
      <Show when={details.error}>
        <div role="alert" class="space-y-3 p-4 text-xs text-muted">
          <p>{t("git.failed")}</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {t("common.retry")}
          </Button>
        </div>
      </Show>
      <Show when={!details.error && details()}>
        {(details) => (
          <>
            <header class="shrink-0 border-b border-line p-4">
              <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <GitCommitHorizontal class="size-4" aria-hidden="true" />
                <span class="font-mono" title={props.oid}>
                  {props.oid.slice(0, 7)}
                </span>
                <span>{details().commit.author}</span>
                <time
                  datetime={new Date(
                    details().commit.timestamp * 1000,
                  ).toISOString()}
                >
                  {new Intl.DateTimeFormat(locale(), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(details().commit.timestamp * 1000)}
                </time>
              </div>
              <h2 class="mt-2 break-words text-sm font-medium">
                {details().commit.subject}
              </h2>
              <Show when={details().body}>
                <p class="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">
                  {details().body}
                </p>
              </Show>
              <p class="mt-3 flex flex-wrap gap-2 text-[11px] text-muted">
                <span>
                  {t(
                    details().commit.parents.length > 1
                      ? "git.firstParent"
                      : "git.compare",
                  )}
                </span>
                <span class="font-mono" title={details().base ?? undefined}>
                  {details().base?.slice(0, 7) ?? t("git.emptyTree")} →{" "}
                  {props.oid.slice(0, 7)}
                </span>
              </p>
            </header>
            <Show when={details().commit.oid} keyed>
              {(oid) => (
                <FileChanges
                  items={items()}
                  visible={props.visible}
                  headerControls={(file) => (
                    <span
                      class={`shrink-0 font-mono text-[11px] ${changeColor(file().change)}`}
                    >
                      {file().change}
                    </span>
                  )}
                  empty={
                    <p class="p-4 text-xs text-muted">
                      {t(
                        details().boundary
                          ? "git.shallowBoundary"
                          : "git.emptyCommit",
                      )}
                    </p>
                  }
                >
                  {(file, context) => (
                    <CommitFile
                      threadId={props.threadId}
                      oid={oid}
                      file={file()}
                      index={file().index}
                      context={context}
                    />
                  )}
                </FileChanges>
              )}
            </Show>
            <footer class="shrink-0 border-t border-line px-3 py-2 text-[11px] text-muted">
              {t("git.readOnly")}
            </footer>
          </>
        )}
      </Show>
    </section>
  );
}
