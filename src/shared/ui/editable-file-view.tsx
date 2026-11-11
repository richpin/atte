import {
  getFiletypeFromFileName,
  getSharedHighlighter,
  VirtualizedFile,
  Virtualizer,
} from "@pierre/diffs";
import {
  Editor,
  type EditorViewState,
  EditStateManager,
} from "@pierre/diffs/edit";
import { createEffect, createMemo, onCleanup, untrack } from "solid-js";
import { useTheme } from "../theme";
import { bindEditHistory } from "./edit-history";

export function EditableFile(props: {
  path: string;
  text: string;
  revision: number;
  readOnly: boolean;
  visible: boolean;
  onChange: (text: string) => void;
  onError: (error: unknown) => void;
}) {
  const { resolvedTheme } = useTheme();
  const readOnlyValue = createMemo(() => props.readOnly);
  let scrollRoot!: HTMLDivElement;
  let content!: HTMLDivElement;
  let mount!: HTMLDivElement;
  let active: { file: VirtualizedFile; virtualizer: Virtualizer } | undefined;
  let view: EditorViewState | undefined;
  const editStateKey = crypto.randomUUID();
  let revision = untrack(() => props.revision);
  let disposeActive: (() => void) | undefined;
  onCleanup(() => {
    disposeActive?.();
    EditStateManager.clear("file", editStateKey);
  });
  createEffect(() => {
    const path = props.path;
    const nextRevision = props.revision;
    if (revision !== nextRevision) {
      EditStateManager.clear("file", editStateKey);
      revision = nextRevision;
    }
    const text = untrack(() => props.text);
    const readOnly = readOnlyValue();
    let dead = false;
    let dispose: (() => void) | undefined;
    void (async () => {
      let lang = getFiletypeFromFileName(path);
      try {
        await getSharedHighlighter({
          themes: ["github-light", "github-dark"],
          langs: [lang],
          preferredHighlighter: "shiki-js",
        });
      } catch {
        lang = "text";
        await getSharedHighlighter({
          themes: ["github-light", "github-dark"],
          langs: [lang],
          preferredHighlighter: "shiki-js",
        });
      }
      if (dead) return;
      const virtualizer = new Virtualizer();
      virtualizer.setup(scrollRoot, content);
      const file = new VirtualizedFile(
        {
          theme: { light: "github-light", dark: "github-dark" },
          themeType: untrack(resolvedTheme),
          preferredHighlighter: "shiki-js",
          disableFileHeader: true,
          overflow: "scroll",
          unsafeCSS: ":host { --diffs-font-size: 12px; }",
          onEditComplete: () => "accept",
        },
        virtualizer,
      );
      let editor: Editor<"file"> | undefined;
      let cleaned = false;
      let unbindHistory: (() => void) | undefined;
      dispose = () => {
        if (cleaned) return;
        cleaned = true;
        unbindHistory?.();
        if (editor) {
          view = editor.getViewState();
          editor.cleanUp("discard");
        }
        file.cleanUp();
        virtualizer.cleanUp();
        active = undefined;
      };
      disposeActive = dispose;
      file.render({
        file: { name: path, contents: text, lang },
        containerWrapper: mount,
      });
      if (!readOnly) {
        editor = new Editor(
          "file",
          {
            ownsVerticalViewport: true,
            onAttach: (instance) => {
              if (view) {
                instance.setViewState(view);
                view = undefined;
              }
            },
            onChange: (event) => props.onChange(event.file.contents),
          },
          editStateKey,
        );
        editor.edit(file);
        unbindHistory = bindEditHistory(scrollRoot, (action) =>
          editor?.[action](),
        );
      }
      active = { file, virtualizer };
    })().catch((error) => {
      dispose?.();
      if (!dead) props.onError(error);
    });
    onCleanup(() => {
      dead = true;
      dispose?.();
    });
  });
  createEffect(() => {
    const theme = resolvedTheme();
    if (!props.visible) return;
    const frame = requestAnimationFrame(() => {
      active?.file.setThemeType(theme);
      active?.virtualizer.markDOMDirty();
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  return (
    <div ref={scrollRoot} class="h-full min-h-0 overflow-auto">
      <div ref={content}>
        <div ref={mount} />
      </div>
    </div>
  );
}
