import { Sparkles } from "lucide-solid";
import { baseKeymap } from "prosemirror-commands";
import { closeHistory, history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Slice } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { createFileMentionChip } from "shared/ui";
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { mentionFileName } from "../model/file-mentions";
import {
  type CommandToken,
  documentPosition,
  promptDocument,
  promptSchema,
  promptValue,
  textOffset,
} from "../model/prompt-document";
import type { FileMention } from "../model/types";

export interface PromptEditorHandle {
  dom: HTMLElement;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus: () => void;
  setSelectionRange: (start: number, end: number) => void;
  replaceText: (
    start: number,
    end: number,
    text: string,
    cursor?: number,
  ) => void;
  insertCommand: (
    start: number,
    end: number,
    name: string,
    suffix: string,
  ) => void;
  insertMention: (
    start: number,
    end: number,
    path: string,
    order: number,
  ) => void;
}

export function PromptEditor(props: {
  value: string;
  mentions: FileMention[];
  commands: CommandToken[];
  disabled: boolean;
  scope?: string;
  label: string;
  placeholder: string;
  listId?: string;
  expanded?: boolean;
  activeDescendant?: string;
  hasCompletion: boolean;
  ref: (handle: PromptEditorHandle) => void;
  onInput: (
    handle: PromptEditorHandle,
    mentions: FileMention[],
    commands: CommandToken[],
  ) => void;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onBlur: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onPaste: (event: ClipboardEvent) => void;
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let handle: PromptEditorHandle;
  function copySelection(editor: EditorView, event: ClipboardEvent) {
    if (!event.clipboardData || editor.state.selection.empty) return false;
    const slice = editor.state.selection.content();
    const data = promptValue(
      promptSchema.nodes.doc.create(null, slice.content),
    );
    event.clipboardData.setData("text/plain", data.value);
    event.clipboardData.setData(
      "application/x-atte-prompt",
      JSON.stringify(data),
    );
    event.clipboardData.setData(
      "text/html",
      editor.serializeForClipboard(slice).dom.innerHTML,
    );
    event.preventDefault();
    return true;
  }
  onMount(() => {
    view = new EditorView(host, {
      state: state(),
      nodeViews: {
        command(node) {
          const dom = (
            <span
              data-command={node.attrs.name}
              title={`/${node.attrs.name}`}
              contentEditable={false}
              class="inline-flex max-w-full items-center gap-1 rounded-md bg-command/10 px-1.5 py-0.5 align-middle text-command"
            >
              <Sparkles aria-hidden="true" class="size-3.5 shrink-0" />
              <span class="min-w-0 truncate">{node.attrs.name}</span>
            </span>
          ) as HTMLElement;
          return { dom };
        },
        mention(node) {
          const chip = createFileMentionChip(
            node.attrs.path,
            mentionFileName(node.attrs.path),
          );
          chip.dataset.mentionId = node.attrs.id;
          chip.dataset.mentionOrder = String(node.attrs.order);
          chip.contentEditable = "false";
          return { dom: chip };
        },
      },
      editable: () => !props.disabled,
      attributes: attributes(),
      dispatchTransaction(transaction) {
        if (!view) return;
        view.updateState(view.state.apply(transaction));
        if (transaction.docChanged)
          props.onInput(
            handle,
            promptValue(view.state.doc).mentions,
            promptValue(view.state.doc).commands,
          );
        props.onSelect();
      },
      handleDOMEvents: {
        copy: copySelection,
        cut: (editor, event) => {
          if (!copySelection(editor, event)) return false;
          if (!props.disabled)
            editor.dispatch(editor.state.tr.deleteSelection());
          return true;
        },
        keydown: (_view, event) => {
          props.onKeyDown(event);
          return event.defaultPrevented;
        },
        blur: () => {
          props.onBlur();
          return false;
        },
        compositionstart: () => {
          props.onCompositionStart();
          return false;
        },
        compositionend: () => {
          queueMicrotask(props.onCompositionEnd);
          return false;
        },
        paste: (_view, event) => {
          props.onPaste(event);
          return event.defaultPrevented;
        },
        click: (editor, event) => {
          const command = (event.target as Element).closest<HTMLElement>(
            "[data-command]",
          );
          if (command && !props.disabled) {
            const start = textOffset(
              editor.state.doc,
              editor.posAtDOM(command, 0),
            );
            const text = `/${command.dataset.command}`;
            handle.replaceText(start, start + text.length, text);
            editor.focus();
            return true;
          }
          const chip = (event.target as Element).closest<HTMLElement>(
            "[data-file-mention]",
          );
          if (chip) {
            chip.title = chip.dataset.fileMention ?? "";
          }
          return false;
        },
      },
      clipboardTextSerializer: (slice) =>
        promptValue(promptSchema.nodes.doc.create(null, slice.content)).value,
      // Ignore arbitrary HTML formatting. Only editor-produced mention slices retain chips.
      handlePaste: (_view, event) => {
        const internal = event.clipboardData?.getData(
          "application/x-atte-prompt",
        );
        if (internal && view) {
          try {
            const data = JSON.parse(internal);
            if (
              typeof data.value === "string" &&
              Array.isArray(data.mentions) &&
              data.mentions.every(
                (m: FileMention) =>
                  m &&
                  typeof m.path === "string" &&
                  typeof m.start === "number" &&
                  typeof m.end === "number" &&
                  typeof m.order === "number",
              )
            ) {
              const order =
                Math.max(
                  -1,
                  ...promptValue(view.state.doc).mentions.map((m) => m.order),
                ) + 1;
              const mentions = data.mentions.map(
                (m: FileMention, index: number) => ({
                  ...m,
                  id: crypto.randomUUID(),
                  order: order + index,
                }),
              );
              view.dispatch(
                view.state.tr.replaceSelection(
                  new Slice(
                    promptDocument(data.value, mentions, data.commands ?? [])
                      .content,
                    0,
                    0,
                  ),
                ),
              );
              return true;
            }
          } catch {
            /* Other clipboard formats remain available. */
          }
        }
        if (event.clipboardData?.getData("text/html").includes("data-pm-slice"))
          return false;
        const text = event.clipboardData?.getData("text/plain");
        if (!text || !view) return false;
        view.dispatch(
          view.state.tr.replaceSelection(
            new Slice(promptDocument(text, []).content, 0, 0),
          ),
        );
        return true;
      },
    });
    handle = {
      dom: view.dom,
      get value() {
        return view ? promptValue(view.state.doc).value : "";
      },
      get selectionStart() {
        return view ? textOffset(view.state.doc, view.state.selection.from) : 0;
      },
      get selectionEnd() {
        return view ? textOffset(view.state.doc, view.state.selection.to) : 0;
      },
      focus: () => view?.focus(),
      setSelectionRange(start, end) {
        if (view)
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.create(
                view.state.doc,
                documentPosition(view.state.doc, start),
                documentPosition(view.state.doc, end),
              ),
            ),
          );
      },
      replaceText(start, end, text, cursor) {
        if (!view) return;
        const from = documentPosition(view.state.doc, start);
        const to = documentPosition(view.state.doc, end);
        const content = promptDocument(text, []).content;
        const tr = view.state.tr.replaceWith(from, to, content);
        tr.setSelection(
          TextSelection.create(
            tr.doc,
            cursor === undefined
              ? from + content.size
              : documentPosition(tr.doc, cursor),
          ),
        );
        view.dispatch(tr);
      },
      insertCommand(start, end, name, suffix) {
        if (!view) return;
        const from = documentPosition(view.state.doc, start);
        const to = documentPosition(view.state.doc, end);
        const tr = view.state.tr.replaceWith(from, to, [
          promptSchema.nodes.command.create({ name }),
          ...(suffix ? [promptSchema.text(suffix)] : []),
        ]);
        tr.setSelection(TextSelection.create(tr.doc, from + 1 + suffix.length));
        view.dispatch(closeHistory(tr).scrollIntoView());
        view.dispatch(closeHistory(view.state.tr));
        view.focus();
      },
      insertMention(start, end, path, order) {
        if (!view) return;
        const from = documentPosition(view.state.doc, start);
        const to = documentPosition(view.state.doc, end);
        const node = promptSchema.nodes.mention.create({
          id: crypto.randomUUID(),
          path,
          order,
        });
        const tr = view.state.tr.replaceWith(from, to, [
          node,
          promptSchema.text(" "),
        ]);
        tr.setSelection(TextSelection.create(tr.doc, from + 2));
        view.dispatch(closeHistory(tr).scrollIntoView());
        view.dispatch(closeHistory(view.state.tr));
        view.focus();
      },
    };
    props.ref(handle);
  });
  function state() {
    return EditorState.create({
      doc: promptDocument(props.value, props.mentions, props.commands),
      plugins: [
        history(),
        keymap({
          Backspace: (state, dispatch) => {
            const { selection } = state;
            const before = selection.$from.nodeBefore;
            if (
              !selection.empty ||
              !before ||
              !["mention", "command"].includes(before.type.name)
            )
              return false;
            dispatch?.(
              state.tr.delete(selection.from - before.nodeSize, selection.from),
            );
            return true;
          },
          Delete: (state, dispatch) => {
            const { selection } = state;
            const after = selection.$from.nodeAfter;
            if (
              !selection.empty ||
              !after ||
              !["mention", "command"].includes(after.type.name)
            )
              return false;
            dispatch?.(
              state.tr.delete(selection.from, selection.from + after.nodeSize),
            );
            return true;
          },
          "Mod-z": undo,
          "Mod-Shift-z": redo,
          "Mod-y": redo,
          "Shift-Enter": (s, dispatch) => {
            dispatch?.(
              s.tr
                .replaceSelectionWith(promptSchema.nodes.hard_break.create())
                .scrollIntoView(),
            );
            return true;
          },
        }),
        keymap(baseKeymap),
      ],
    });
  }
  function attributes() {
    return {
      role: props.hasCompletion ? "combobox" : "textbox",
      "aria-label": props.label,
      "aria-multiline": "true",
      "aria-disabled": String(props.disabled),
      ...(props.hasCompletion
        ? {
            "aria-autocomplete": "list",
            "aria-haspopup": "listbox",
            "aria-expanded": String(props.expanded ?? false),
          }
        : {}),
      "aria-controls": props.listId ?? "",
      "aria-activedescendant": props.activeDescendant ?? "",
      "data-placeholder": props.placeholder,
      class:
        "prompt-editor min-h-10 max-h-thread-composer-input w-full min-w-0 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words bg-transparent text-sm leading-5 outline-none",
    };
  }
  createEffect(() => {
    const doc = promptDocument(props.value, props.mentions, props.commands);
    if (view && !view.state.doc.eq(doc))
      view.updateState(
        view.state.apply(
          view.state.tr
            .replaceWith(0, view.state.doc.content.size, doc.content)
            .setMeta("addToHistory", false),
        ),
      );
    view?.setProps({
      attributes: attributes(),
      editable: () => !props.disabled,
    });
  });
  createEffect(
    on(
      () => props.scope,
      () => {
        if (view) view.updateState(state());
      },
    ),
  );
  onCleanup(() => view?.destroy());
  return <div class="min-w-0 flex-1" ref={host} />;
}
