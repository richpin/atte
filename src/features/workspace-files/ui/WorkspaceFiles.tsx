import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { FilePlus, FolderPlus, RotateCw, Save } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Button,
  EditableFile,
  FileTree,
  Resizable,
  ResizableHandle,
  ResizablePanel,
  type TreeAction,
} from "shared/ui";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { subscribeFiles } from "../api/files";
import { imageMime, isSvg } from "../lib/file-kind";
import { dirty, type FilesModel, treeWidth, within } from "../model/files";
import type { FilesManager } from "../model/manager";
import { FileImagePreview, SvgPreview } from "./FileImagePreview";

export function WorkspaceFiles(props: {
  model: FilesModel;
  manager: FilesManager;
  visible: boolean;
}) {
  const { t } = useI18n();
  const model = props.model;
  const [selection, setSelection] = createSignal<{
    path: string;
    directory: boolean;
  }>();
  const [width, setWidth] = createSignal(360);
  const [anchor, setAnchor] = createSignal({ width: 360, tree: 140 });
  const [comparing, setComparing] = createSignal(false);
  const [sourcePath, setSourcePath] = createSignal<string>();
  const svgPreview = () => {
    const path = model.selected();
    return !!path && isSvg(path) && sourcePath() !== path;
  };
  const dirtyKey = createMemo(() =>
    model
      .pending()
      .map((draft) => draft.path)
      .join("\0"),
  );
  const [fatal, setFatal] = createSignal(false);
  let root!: HTMLDivElement;
  const { observe } = makeResizeObserver((entries) => {
    if (entries[0].contentRect.width) setWidth(entries[0].contentRect.width);
  });
  onMount(() => {
    observe(root);
  });
  const sizes = createMemo(() => {
    const left = treeWidth(width(), anchor().width, anchor().tree) / width();
    return [left, 1 - left];
  });
  createEffect(() => {
    model.generation();
    if (!props.visible) return;
    let dead = false;
    const subscription = subscribeFiles(model.threadId, (update) => {
      if (!dead) void model.update(update);
    }).catch((cause) => {
      if (!dead) model.setError(cause);
      return undefined;
    });
    onCleanup(() => {
      dead = true;
      void subscription.then((stop) => stop?.());
    });
  });
  const description = (cause: unknown) => {
    if (typeof cause === "string") {
      const labels: Record<string, string> = {
        accessDenied: t("files.accessDenied"),
        conflict: t("files.conflict"),
        unsupported: t("files.unsupported"),
        exists: t("files.exists"),
        invalidPath: t("files.invalidPath"),
        missing: t("files.missing"),
        readOnly: t("files.readOnly"),
      };
      return labels[cause] ?? cause;
    }
    return cause ? t("files.failed") : "";
  };
  async function action(
    kind: Exclude<TreeAction, "rename">,
    path = selection()?.path ?? "",
    directory = selection()?.directory ?? true,
  ) {
    if (model.busy()) return;
    if (kind === "trash") {
      if (!path) return;
      const affected = model
        .pending()
        .filter((draft) => within(draft.path, path));
      const choice = await props.manager.ask({
        title: t("files.trash"),
        message: affected.length
          ? `${t("files.trashUnsaved")}\n${affected.map((draft) => draft.path).join("\n")}`
          : path,
        choices: [
          { id: "trash", label: t("files.trash") },
          { id: "cancel", label: t("files.cancel") },
        ],
      });
      if (
        choice.choice === "trash" &&
        (await model.operation({ type: "trash", path }))
      ) {
        const previous = selection();
        if (previous && within(previous.path, path)) setSelection(undefined);
      }
      return;
    }
    const parent = directory ? path : path.split("/").slice(0, -1).join("/");
    const choice = await props.manager.ask({
      title: t(kind === "newFile" ? "files.newFile" : "files.newFolder"),
      message: parent || "/",
      input: "",
      choices: [
        { id: "create", label: t("files.create") },
        { id: "cancel", label: t("files.cancel") },
      ],
    });
    if (choice.choice !== "create") return;
    if (
      !choice.text ||
      choice.text.includes("/") ||
      [".", "..", ".git"].includes(choice.text)
    ) {
      model.setError("invalidPath");
      return;
    }
    const created = {
      path: [parent, choice.text].filter(Boolean).join("/"),
      directory: kind === "newFolder",
    };
    if (await model.operation({ type: "create", ...created }))
      setSelection(created);
  }
  async function reload() {
    const draft = model.current();
    if (!draft) return;
    if (dirty(draft)) {
      const choice = await props.manager.ask({
        title: t("files.reload"),
        message: t("files.reloadConfirm"),
        choices: [
          { id: "reload", label: t("files.reload") },
          { id: "cancel", label: t("files.cancel") },
        ],
      });
      if (choice.choice !== "reload") return;
    }
    await model.reload(draft.id);
    setComparing(false);
  }
  const labels = createMemo(() => ({
    newFile: t("files.newFile"),
    newFolder: t("files.newFolder"),
    rename: t("files.rename"),
    trash: t("files.trash"),
  }));
  return (
    <section
      class="flex h-full min-h-0 flex-col"
      aria-label="Files"
      onKeyDown={(event) => {
        if (
          props.visible &&
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          const draft = model.current();
          if (draft) void model.save(draft.id);
        }
      }}
    >
      <Show when={model.error()}>
        <p
          role="alert"
          class="shrink-0 break-words border-b border-line px-2 py-1 text-xs text-muted"
        >
          {description(model.error())}
        </p>
      </Show>
      <Show when={model.warnings().length}>
        <p
          role="status"
          class="shrink-0 px-2 text-xs text-muted"
          title={model.warnings().join("\n")}
        >
          {t("files.partial")}
        </p>
      </Show>
      <Resizable
        ref={root}
        sizes={sizes()}
        onSizesChange={(next) => {
          if (!next[0] || Math.abs(next[0] - sizes()[0]) < 0.000001) return;
          setAnchor({ width: width(), tree: next[0] * width() });
        }}
        class="min-h-0 flex-1"
      >
        <ResizablePanel
          minSize="100px"
          class="flex min-h-0 min-w-0 flex-col overflow-hidden"
        >
          <div class="flex h-9 shrink-0 items-center border-b border-line px-1">
            <Button
              size="icon"
              variant="ghost"
              class="size-7"
              aria-label={t("files.newFile")}
              disabled={model.busy()}
              onClick={() => void action("newFile")}
            >
              <FilePlus class="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              class="size-7"
              aria-label={t("files.newFolder")}
              disabled={model.busy()}
              onClick={() => void action("newFolder")}
            >
              <FolderPlus class="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              class="size-7"
              aria-label={t("files.refresh")}
              onClick={model.retry}
            >
              <RotateCw class="size-3.5" />
            </Button>
          </div>
          <Show when={model.loading()}>
            <p role="status" class="px-2 py-1 text-xs text-muted">
              {t("files.loading")}
            </p>
          </Show>
          <div class="min-h-0 flex-1">
            <FileTree
              entries={model.entries()}
              loading={model.loading()}
              selectedPath={selection()?.path}
              dirtyLabel={t("files.unsavedTitle")}
              dirtyPaths={dirtyKey() ? dirtyKey().split("\0") : []}
              disabled={model.busy()}
              labels={labels()}
              onSelect={(path, directory) => {
                setSelection({ path, directory });
                if (!directory) {
                  setFatal(false);
                  setComparing(false);
                  setSourcePath(undefined);
                  void model.open(path);
                }
              }}
              onAction={(kind, path, directory) =>
                void action(kind, path, directory)
              }
              onMove={async (from, to) => {
                const moved = await model.operation({ type: "move", from, to });
                const previous = selection();
                if (moved && previous && within(previous.path, from))
                  setSelection({
                    ...previous,
                    path: to + previous.path.slice(from.length),
                  });
                return moved;
              }}
              onError={model.setError}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle aria-label={t("files.resize")} class="w-px bg-line" />
        <ResizablePanel
          minSize="160px"
          class="flex min-h-0 min-w-0 flex-col overflow-hidden"
        >
          <Show when={model.selected() && !model.current()}>
            <div class="flex min-h-9 shrink-0 items-center gap-1 border-b border-line px-2 text-xs">
              <span class="min-w-0 flex-1 truncate" title={model.selected()}>
                {model.selected()}
              </span>
              <Show when={imageMime(model.selected() ?? "")}>
                <span>{t("files.readOnly")}</span>
              </Show>
            </div>
          </Show>
          <Show
            when={model.current()}
            fallback={
              <Show when={!model.selected()}>
                <p class="p-3 text-xs text-muted">{t("files.select")}</p>
              </Show>
            }
          >
            {(draft) => (
              <>
                <div class="flex min-h-9 shrink-0 items-center gap-1 border-b border-line px-2 text-xs">
                  <span class="min-w-0 flex-1 truncate" title={draft().path}>
                    {dirty(draft()) ? "● " : ""}
                    {draft().path}
                  </span>
                  <Show when={isSvg(draft().path)}>
                    <Button
                      size="sm"
                      variant="ghost"
                      class="h-7 px-2"
                      aria-pressed={!svgPreview()}
                      onClick={() => setSourcePath(draft().path)}
                    >
                      {t("files.source")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      class="h-7 px-2"
                      aria-pressed={svgPreview()}
                      onClick={() => setSourcePath(undefined)}
                    >
                      {t("files.preview")}
                    </Button>
                  </Show>
                  <Show when={draft().disk.readOnly}>
                    <span>{t("files.readOnly")}</span>
                  </Show>
                  <Button
                    size="icon"
                    variant="ghost"
                    class="size-7"
                    aria-label={t("files.save")}
                    disabled={
                      !dirty(draft()) ||
                      draft().saving ||
                      !!draft().problem ||
                      draft().disk.readOnly ||
                      model.busy()
                    }
                    onClick={() => void model.save(draft().id)}
                  >
                    <Save class="size-3.5" />
                  </Button>
                </div>
                <Show when={draft().problem}>
                  <div
                    role="alert"
                    class="shrink-0 border-b border-line p-2 text-xs"
                  >
                    <p>
                      {draft().problem === "conflict"
                        ? t("files.conflict")
                        : t("files.missing")}
                    </p>
                    <div class="flex flex-wrap gap-1">
                      <Show when={draft().external}>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setComparing((value) => !value)}
                        >
                          {t("files.compare")}
                        </Button>
                      </Show>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void reload()}
                      >
                        {t("files.reload")}
                      </Button>
                    </div>
                  </div>
                </Show>
                <Show when={comparing() && draft().external}>
                  <div class="max-h-48 shrink-0 overflow-auto border-b border-line p-2">
                    <p class="text-xs text-muted">{t("files.diskVersion")}</p>
                    <pre class="select-text whitespace-pre text-xs">
                      {draft().external?.text}
                    </pre>
                  </div>
                </Show>
              </>
            )}
          </Show>
          <div class="min-h-0 flex-1">
            <Show
              when={model.selected() && !model.current() && model.openError()}
            >
              <p
                role="alert"
                class="flex h-full items-center justify-center break-words p-4 text-center text-sm text-muted"
              >
                {description(model.openError())}
              </p>
            </Show>
            <Show
              when={
                props.visible &&
                svgPreview() &&
                !model.current() &&
                !model.error()
              }
            >
              <p role="status" class="p-3 text-xs text-muted">
                {t("files.imageLoading")}
              </p>
            </Show>
            <Show when={props.visible && imageMime(model.selected() ?? "")}>
              <FileImagePreview
                threadId={model.threadId}
                path={model.selected() as string}
                revision={model.imageRevision()}
              />
            </Show>
            <Show
              when={props.visible && svgPreview() && model.selected()}
              keyed
            >
              {(path) => (
                <Show when={model.current()}>
                  {(draft) => (
                    <Show
                      when={!draft().problem || draft().problem === "conflict"}
                    >
                      <SvgPreview text={draft().text} path={path} />
                    </Show>
                  )}
                </Show>
              )}
            </Show>
            <For each={Object.values(model.drafts)}>
              {(draft) => (
                <div
                  hidden={
                    draft.path !== model.selected() ||
                    svgPreview() ||
                    !!imageMime(model.selected() ?? "")
                  }
                  class="h-full min-h-0"
                >
                  <Show
                    when={!fatal()}
                    fallback={
                      <pre class="select-text overflow-auto p-2 text-xs">
                        {draft.text}
                      </pre>
                    }
                  >
                    <EditableFile
                      path={draft.path}
                      text={draft.text}
                      revision={draft.revision}
                      readOnly={draft.disk.readOnly}
                      visible={
                        props.visible &&
                        draft.path === model.selected() &&
                        !svgPreview() &&
                        !imageMime(draft.path)
                      }
                      onChange={(text) => model.change(draft.id, text)}
                      onError={(cause) => {
                        setFatal(true);
                        model.setError(
                          cause instanceof Error ? cause.message : cause,
                        );
                      }}
                    />
                  </Show>
                </div>
              )}
            </For>
          </div>
        </ResizablePanel>
      </Resizable>
    </section>
  );
}
