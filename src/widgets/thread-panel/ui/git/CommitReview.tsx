import { FileCode, GitCommitHorizontal } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Button, FileDiff } from "shared/ui";
import {
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import {
  type ChangedFile,
  readCommit,
  readCommitFile,
} from "../../api/git-history";
import { prepareCommitPatch } from "../../lib/git-patch";

function CommitFile(props: {
  threadId: string;
  oid: string;
  file: ChangedFile;
  index: number;
  visible: boolean;
}) {
  const { t } = useI18n();
  let scrollRoot!: HTMLDivElement;
  let scrollContent!: HTMLDivElement;
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
    <div ref={scrollRoot} class="min-h-0 min-w-0 flex-1 overflow-auto">
      <div ref={scrollContent}>
        <header class="border-b border-line px-3 py-3 text-xs text-muted">
          <p class="break-all">
            {props.file.oldPath
              ? `${props.file.oldPath} → ${props.file.path}`
              : props.file.path}
          </p>
          <Show when={props.file.oldMode !== props.file.newMode}>
            <p class="mt-1 font-mono text-[11px]">
              {props.file.oldMode} → {props.file.newMode}
            </p>
          </Show>
          <Show
            when={
              props.file.oldMode === "160000" || props.file.newMode === "160000"
            }
          >
            <p class="mt-1 break-all font-mono text-[11px]">
              {props.file.oldOid} → {props.file.newOid}
            </p>
          </Show>
        </header>
        <Switch>
          <Match when={result.loading}>
            <p role="status" class="p-4 text-xs text-muted">
              {t("git.loadingDiff")}
            </p>
          </Match>
          <Match when={result.error}>
            <div role="alert" class="space-y-3 p-4 text-xs text-muted">
              <p>{t("git.failed")}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
              >
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
                    <p class="p-4 text-xs text-muted">
                      {t("git.metadataOnly")}
                    </p>
                  }
                >
                  {(diff) => (
                    <FileDiff
                      comparison={{ diff: diff() }}
                      fallback={data.patch}
                      scrollRoot={() => scrollRoot}
                      scrollContent={() => scrollContent}
                      visible={props.visible}
                    />
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
  const [selected, setSelected] = createSignal(0);
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
            <div class="flex min-h-0 flex-1 flex-col @min-[600px]:flex-row">
              <div class="max-h-44 shrink-0 overflow-auto border-b border-line @min-[600px]:max-h-none @min-[600px]:w-56 @min-[600px]:border-b-0 @min-[600px]:border-r">
                <p class="border-b border-line px-3 py-2 text-[11px] text-muted">
                  {t("git.files", { count: details().files.length })}
                </p>
                <For each={details().files}>
                  {(file, index) => (
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 border-b border-line px-3 py-3 text-left text-xs hover:bg-panel focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                      classList={{ "bg-panel": selected() === index() }}
                      aria-pressed={selected() === index()}
                      aria-label={`${file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} · ${file.change}`}
                      title={
                        file.oldPath
                          ? `${file.oldPath} → ${file.path}`
                          : file.path
                      }
                      onClick={() => setSelected(index())}
                    >
                      <FileCode
                        aria-hidden="true"
                        class="size-3.5 shrink-0 text-muted"
                      />
                      <span class="min-w-0 flex-1 truncate">
                        {file.path.split("/").at(-1)}
                      </span>
                      <span class="font-mono text-[11px] text-muted">
                        {file.change}
                      </span>
                    </button>
                  )}
                </For>
              </div>
              <Show when={details().files[selected()]} keyed>
                {(file) => (
                  <CommitFile
                    threadId={props.threadId}
                    oid={props.oid}
                    file={file}
                    index={selected()}
                    visible={props.visible}
                  />
                )}
              </Show>
              <Show when={details().files.length === 0}>
                <p class="p-4 text-xs text-muted">
                  {t(
                    details().boundary
                      ? "git.shallowBoundary"
                      : "git.emptyCommit",
                  )}
                </p>
              </Show>
            </div>
            <footer class="shrink-0 border-t border-line px-3 py-2 text-[11px] text-muted">
              {t("git.readOnly")}
            </footer>
          </>
        )}
      </Show>
    </section>
  );
}
