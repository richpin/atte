import { Copy, File, Globe, Save } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  ImagePreview,
  useWebLink,
} from "shared/ui";
import {
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import {
  openResponseFile,
  readResponseContent,
  saveResponseContent,
} from "../api/threads";
import type { ResponseContent } from "../model/types";

export function ResponseContentView(props: {
  content: ResponseContent;
  threadId?: string;
  visible?: boolean;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const openWeb = useWebLink();
  const [expanded, setExpanded] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  createEffect(() => {
    if (!copied()) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    onCleanup(() => clearTimeout(timer));
  });
  const [audioUrl, setAudioUrl] = createSignal<string>();
  const [audioError, setAudioError] = createSignal(false);
  const kind = () =>
    props.content.type === "resource" &&
    (props.content.text === undefined ||
      props.content.mimeType === "image/svg+xml")
      ? props.content.mimeType?.startsWith("image/")
        ? "image"
        : props.content.mimeType?.startsWith("audio/")
          ? "audio"
          : "resource"
      : props.content.type;
  const title = () =>
    props.content.name ||
    (kind() === "image"
      ? t("thread.image")
      : kind() === "audio"
        ? t("thread.audio")
        : t("thread.content.resource"));
  const [blob] = createResource(
    () =>
      props.visible !== false &&
      props.threadId &&
      props.content.id &&
      ["image", "audio"].includes(kind())
        ? {
            threadId: props.threadId,
            id: props.content.id,
            mime: props.content.mimeType,
          }
        : undefined,
    async (source) =>
      new Blob([await readResponseContent(source.threadId, source.id)], {
        type: source.mime,
      }),
  );
  createEffect(() => {
    const current =
      props.visible !== false && !blob.loading && !blob.error
        ? blob()
        : undefined;
    setAudioError(false);
    setExpanded(false);
    if (!current || kind() !== "audio") {
      setAudioUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(current);
    setAudioUrl(url);
    onCleanup(() => URL.revokeObjectURL(url));
  });
  createEffect(() => {
    props.content.id;
    props.content.text;
    props.visible;
    setError(false);
    setCopied(false);
  });
  const canOpen = () =>
    props.content.type === "resource_link" &&
    (/^https?:\/\//i.test(props.content.uri ?? "")
      ? !!openWeb
      : /^file:\/\//i.test(props.content.uri ?? "") &&
        !!props.onOpenFile &&
        !!props.threadId &&
        !!props.content.id);
  async function act(action: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true);
    setError(false);
    try {
      await action();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const open = () =>
    act(async () => {
      if (/^https?:\/\//i.test(props.content.uri ?? ""))
        openWeb?.(props.content.uri as string);
      else if (props.threadId && props.content.id) {
        const threadId = props.threadId;
        const contentId = props.content.id;
        const path = await openResponseFile(threadId, contentId);
        if (
          path !== null &&
          props.threadId === threadId &&
          props.content.id === contentId
        )
          props.onOpenFile?.(path);
      }
    });
  const copy = (text: string) =>
    act(async () => {
      const id = props.content.id;
      setCopied(false);
      await navigator.clipboard.writeText(text);
      if (
        !disposed &&
        props.visible !== false &&
        props.content.id === id &&
        props.content.text === text
      )
        setCopied(true);
    });
  return (
    <Show
      when={props.content.type !== "text"}
      fallback={
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
          {props.content.text}
        </pre>
      }
    >
      <Show
        when={props.content.type === "resource_link"}
        fallback={
          <section
            data-response-content={props.content.type}
            class="min-w-0 rounded-xl border border-line text-sm"
          >
            <div class="flex items-start gap-2 px-3 py-2">
              <File
                aria-hidden="true"
                class="mt-0.5 size-4 shrink-0 text-muted"
              />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p class="min-w-0 flex-1 break-words font-medium">
                    {title()}
                  </p>
                  <Show
                    when={
                      props.content.text !== undefined ||
                      (props.content.hasData &&
                        props.content.id &&
                        props.threadId)
                    }
                  >
                    <div class="ml-auto flex max-w-full shrink-0 flex-wrap justify-end gap-1 text-xs [&_button]:rounded [&_button]:px-2 [&_button]:py-1 [&_button]:font-medium [&_button]:hover:bg-current/10 [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-accent [&_button]:disabled:opacity-40">
                      <Show when={props.content.text !== undefined}>
                        <button
                          type="button"
                          disabled={busy()}
                          class="inline-flex items-center gap-1 whitespace-nowrap"
                          onClick={() =>
                            void copy(props.content.text as string)
                          }
                        >
                          <Show when={!copied()}>
                            <Copy aria-hidden="true" class="size-3.5" />
                          </Show>
                          <span aria-live="polite">
                            {t(
                              copied()
                                ? "thread.content.copied"
                                : "thread.content.copyText",
                            )}
                          </span>
                        </button>
                      </Show>
                      <Show
                        when={
                          props.content.hasData &&
                          props.content.id &&
                          props.threadId
                        }
                      >
                        <button
                          type="button"
                          disabled={busy()}
                          class="inline-flex items-center gap-1 whitespace-nowrap"
                          onClick={() =>
                            void act(() =>
                              saveResponseContent(
                                props.threadId as string,
                                props.content.id as string,
                                t("thread.content.save"),
                              ),
                            )
                          }
                        >
                          <Save aria-hidden="true" class="size-3.5" />
                          {t("thread.content.save")}
                        </button>
                      </Show>
                    </div>
                  </Show>
                </div>
                <Show when={props.content.uri}>
                  <p class="break-all text-xs text-muted">
                    {props.content.uri}
                  </p>
                </Show>
                <Show when={props.content.size != null}>
                  <p class="text-xs text-muted">
                    {props.content.size?.toLocaleString()} B
                  </p>
                </Show>
                <Show when={props.content.description}>
                  <p class="mt-1 whitespace-pre-wrap break-words text-xs">
                    {props.content.description}
                  </p>
                </Show>
              </div>
            </div>
            <Show
              when={
                props.visible !== false && ["image", "audio"].includes(kind())
              }
            >
              <Show
                when={!blob.loading}
                fallback={
                  <p role="status" class="px-3 pb-3 text-xs text-muted">
                    {t("thread.content.loading")}
                  </p>
                }
              >
                <Show
                  when={!blob.error && blob()}
                  fallback={
                    <p role="alert" class="px-3 pb-3 text-xs text-muted">
                      {t("thread.content.previewFailed")}
                    </p>
                  }
                >
                  {(current) => (
                    <Show
                      when={kind() === "image"}
                      fallback={
                        <Show when={audioUrl()}>
                          {(url) => (
                            <div class="px-3 pb-3">
                              {/* biome-ignore lint/a11y/useMediaCaption: ACP audio blocks do not include caption tracks. */}
                              <audio
                                ref={(element) =>
                                  onCleanup(() => {
                                    element.pause();
                                    element.removeAttribute("src");
                                    element.load();
                                  })
                                }
                                controls
                                preload="metadata"
                                src={url()}
                                aria-label={title()}
                                class="w-full [color-scheme:light] dark:[color-scheme:dark]"
                                onError={() => setAudioError(true)}
                              />
                              <Show when={audioError()}>
                                <p role="alert" class="text-xs text-muted">
                                  {t("thread.content.previewFailed")}
                                </p>
                              </Show>
                            </div>
                          )}
                        </Show>
                      }
                    >
                      <button
                        type="button"
                        aria-label={t("thread.content.enlarge", {
                          name: title(),
                        })}
                        class="block max-h-80 w-full focus-visible:outline-2 focus-visible:outline-accent [&_img]:max-h-72"
                        onClick={() => setExpanded(true)}
                      >
                        <ImagePreview
                          blob={current() as Blob}
                          alt={title()}
                          loadingLabel={t("thread.content.loading")}
                          errorLabel={t("thread.content.previewFailed")}
                        />
                      </button>
                      <Dialog open={expanded()} onOpenChange={setExpanded}>
                        <DialogContent
                          class="h-[85vh] max-w-[90vw] grid-rows-[auto_minmax(0,1fr)] bg-panel text-ink"
                          closeLabel={t("thread.content.close")}
                        >
                          <DialogTitle>{title()}</DialogTitle>
                          <ImagePreview
                            blob={current() as Blob}
                            alt={title()}
                            loadingLabel={t("thread.content.loading")}
                            errorLabel={t("thread.content.previewFailed")}
                          />
                        </DialogContent>
                      </Dialog>
                    </Show>
                  )}
                </Show>
              </Show>
            </Show>
            <Show
              when={
                props.content.type === "resource" &&
                props.content.text !== undefined
              }
            >
              <details class="border-t border-line px-3 py-2">
                <summary class="cursor-pointer text-xs">
                  {t("thread.content.showText")}
                </summary>
                <pre class="mt-2 max-h-64 select-text overflow-auto whitespace-pre-wrap break-words text-xs">
                  {props.content.text}
                </pre>
              </details>
            </Show>
            <Show
              when={
                !["image", "audio", "resource_link"].includes(kind()) &&
                props.content.text === undefined
              }
            >
              <p class="px-3 pb-2 text-xs text-muted">
                {t("thread.content.unsupported")}
              </p>
            </Show>
            <Show when={error()}>
              <p role="alert" class="px-3 pb-2 text-xs text-muted">
                {t("thread.content.actionFailed")}
              </p>
            </Show>
          </section>
        }
      >
        <div data-response-content="resource_link" class="min-w-0 text-sm">
          <Show
            when={canOpen()}
            fallback={
              <span class="break-all" title={props.content.uri}>
                {props.content.name || props.content.uri || title()}
              </span>
            }
          >
            <a
              href={props.content.uri}
              title={[props.content.uri, props.content.description]
                .filter(Boolean)
                .join("\n")}
              aria-disabled={busy()}
              class="inline-flex max-w-full items-start gap-1 text-link underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-accent aria-disabled:opacity-40"
              onClick={(event) => {
                event.preventDefault();
                void open();
              }}
            >
              <Show
                when={/^file:\/\//i.test(props.content.uri ?? "")}
                fallback={
                  <Globe aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
                }
              >
                <File aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
              </Show>
              <span class="break-all">
                {props.content.name || props.content.uri || title()}
              </span>
            </a>
          </Show>
          <Show when={error()}>
            <p role="alert" class="mt-1 text-xs text-muted">
              {t("thread.content.actionFailed")}
            </p>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
