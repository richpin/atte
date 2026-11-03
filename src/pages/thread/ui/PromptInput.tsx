import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { Sparkles } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { closeMentionSearch, searchMentionFiles } from "../api/threads";
import { matchingFiles, mentionQuery } from "../model/file-mentions";
import type { CommandToken } from "../model/prompt-document";
import {
  commandName,
  commandQuery,
  completeCommand,
  matchingCommands,
} from "../model/slash-commands";
import type { AvailableCommand, FileMention } from "../model/types";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { SlashCommandMenu } from "./SlashCommandMenu";

export function PromptInput(props: {
  value: string;
  mentions?: FileMention[];
  commandTokens?: CommandToken[];
  threadId?: string;
  selectedCommand?: string;
  commands?: AvailableCommand[];
  menuAnchor?: HTMLElement;
  focusScope?: string;
  disabled: boolean;
  focusKey?: string;
  inputRef?: (element: PromptEditorHandle) => void;
  onInput: (
    value: string,
    command?: string,
    mentions?: FileMention[],
    commandTokens?: CommandToken[],
  ) => void;
  onSubmit: () => void;
  onPasteImage?: (image: File) => void;
  onUnsupportedImagePaste?: () => void;
}) {
  const { t } = useI18n();
  let input: PromptEditorHandle | undefined;
  const listId = createUniqueId();
  const commandTokens = () => props.commandTokens ?? [];
  const visibleCommands = () =>
    commandTokens().map((c) => ({
      ...c,
      start: c.start - prefixLength(),
      end: c.end - prefixLength(),
    }));
  const [selection, setSelection] = createSignal({ start: 0, end: 0 });
  const [requested, setRequested] = createSignal(false);
  const [composing, setComposing] = createSignal(false);
  const [highlighted, setHighlighted] = createSignal<string>();
  const [paths, setPaths] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [searchFailed, setSearchFailed] = createSignal(false);
  const selectedCommand = () =>
    props.selectedCommand && commandName(props.value) === props.selectedCommand
      ? props.selectedCommand
      : undefined;
  const prefixLength = () =>
    selectedCommand() ? props.value.length - visibleValue().length : 0;
  const visibleValue = () => {
    const name = selectedCommand();
    if (!name) return props.value;
    const body = props.value.slice(name.length + 1);
    return body.startsWith(" ") ? body.slice(1) : body;
  };
  const visibleMentions = () =>
    (props.mentions ?? []).map((m) => ({
      ...m,
      start: m.start - prefixLength(),
      end: m.end - prefixLength(),
    }));
  const query = () =>
    commandQuery(visibleValue(), selection().start, selection().end);
  const fileQuery = () =>
    props.threadId
      ? mentionQuery(
          visibleValue(),
          selection().start,
          selection().end,
          visibleMentions(),
        )
      : undefined;
  const enabled = () => requested() && !props.disabled && !composing();
  const filesOpen = () => enabled() && fileQuery() !== undefined;
  const open = () =>
    enabled() &&
    (filesOpen() || (props.commands !== undefined && query() !== undefined));
  const matches = createMemo(() =>
    filesOpen()
      ? matchingFiles(paths(), fileQuery()?.query ?? "")
          .slice(0, 100)
          .map((path) => ({
            name: path,
            description: path.slice(0, path.lastIndexOf("/") + 1) || "./",
            inputHint: null,
            path,
          }))
      : matchingCommands(props.commands ?? [], query()?.query ?? ""),
  );
  const selected = () =>
    matches().find((item) => item.name === highlighted()) ?? matches()[0];
  const selectedIndex = () =>
    matches().findIndex((item) => item.name === selected()?.name);
  const hint = () =>
    (props.commands ?? []).find((c) => c.name === commandName(props.value))
      ?.inputHint;

  const searchThread = createMemo(() =>
    filesOpen() ? props.threadId : undefined,
  );
  createEffect(
    on(searchThread, (threadId) => {
      if (!threadId) return;
      const searchId = crypto.randomUUID();
      let current = true;
      setPaths([]);
      setLoading(true);
      setSearchFailed(false);
      void searchMentionFiles(threadId, searchId, "")
        .then((entries) => {
          if (current)
            setPaths(
              entries
                .filter(
                  (e) => !e.directory && !e.path.split("/").includes(".git"),
                )
                .map((e) => e.path),
            );
        })
        .catch(() => {
          if (current) setSearchFailed(true);
        })
        .finally(() => {
          if (current) setLoading(false);
        });
      onCleanup(() => {
        current = false;
        void closeMentionSearch(searchId).catch(() => {});
      });
    }),
  );

  function syncSelection() {
    if (!input) return;
    setSelection({ start: input.selectionStart, end: input.selectionEnd });
    if (
      !commandQuery(input.value, input.selectionStart, input.selectionEnd) &&
      !mentionQuery(
        input.value,
        input.selectionStart,
        input.selectionEnd,
        visibleMentions(),
      )
    )
      setRequested(false);
  }
  function emit(value: string, command?: string, delta = 0) {
    batch(() => {
      const tokens = commandTokens().map((c) => ({
        ...c,
        start: c.start + delta,
        end: c.end + delta,
      }));
      props.onInput(
        value,
        command,
        (props.mentions ?? []).map((m) => ({
          ...m,
          start: m.start + delta,
          end: m.end + delta,
        })),
        tokens,
      );
    });
  }

  function selectItem(item: AvailableCommand) {
    if (filesOpen()) {
      const q = fileQuery();
      if (!q) return;
      const order =
        Math.max(-1, ...(props.mentions ?? []).map((m) => m.order)) + 1;
      input?.insertMention(q.start, q.end, item.name, order);
      setRequested(false);
      return;
    }
    const range = query();
    if (!range) return;
    const name = selectedCommand();
    const prefix = name ? `/${name} ` : "";
    const completed = completeCommand(visibleValue(), item.name, range);
    const tokenize = !name && range.start === 0;
    if (!tokenize) {
      input?.insertCommand(
        range.start,
        range.end,
        item.name,
        range.end === visibleValue().length ? " " : "",
      );
      setRequested(false);
      return;
    }
    const delta = completed.value.length - visibleValue().length;
    const mentions = (props.mentions ?? [])
      .filter(
        (m) =>
          m.end <= prefix.length + range.start ||
          m.start >= prefix.length + range.end,
      )
      .map((m) =>
        m.start >= prefix.length + range.end
          ? { ...m, start: m.start + delta, end: m.end + delta }
          : m,
      );
    setRequested(false);
    props.onInput(
      prefix + completed.value,
      name ?? (tokenize ? item.name : undefined),
      mentions,
      commandTokens().map((c) => ({
        ...c,
        start: c.start + delta,
        end: c.end + delta,
      })),
    );
    input?.focus();
    const cursor = tokenize && selectedCommand() ? 0 : completed.cursor;
    input?.setSelectionRange(cursor, cursor);
    syncSelection();
  }
  function editSelectedCommand() {
    const name = selectedCommand();
    if (!name) return;
    emit(props.value);
    input?.focus();
    input?.setSelectionRange(name.length + 1, name.length + 1);
    syncSelection();
    setRequested(true);
  }
  function removeSelectedCommand() {
    const value = visibleValue();
    emit(value, undefined, -prefixLength());
    setRequested(false);
    input?.focus();
    input?.setSelectionRange(0, 0);
    syncSelection();
  }
  createEffect(
    on(
      () => props.focusScope,
      () => {
        setRequested(false);
        setHighlighted(undefined);
      },
    ),
  );
  createEffect(() => {
    if (!matches().some((c) => c.name === highlighted()))
      setHighlighted(undefined);
  });
  createEffect(
    on(
      () => props.focusKey,
      (key) => {
        if (key) input?.focus();
      },
    ),
  );
  function resizeInput() {
    if (!input) return;
    const element = input.dom;
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight) || 20;
    const pixels = (v: string) => Number.parseFloat(v) || 0;
    const extra =
      pixels(style.paddingTop) +
      pixels(style.paddingBottom) +
      pixels(style.borderTopWidth) +
      pixels(style.borderBottomWidth);
    element.style.height = "0px";
    element.style.height = `${Math.min(Math.max(element.scrollHeight, lineHeight * 2 + extra), lineHeight * 10 + extra)}px`;
  }
  createEffect(
    on(
      () => [props.value, props.selectedCommand] as const,
      () => queueMicrotask(resizeInput),
    ),
  );
  function onKeyDown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229 || composing()) return;
    if (
      selectedCommand() &&
      input?.selectionStart === 0 &&
      input.selectionEnd === 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      if (event.key === "Backspace") {
        event.preventDefault();
        removeSelectedCommand();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        editSelectedCommand();
        return;
      }
    }
    if (open()) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setRequested(false);
        return;
      }
      if (
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const index = Math.max(
            0,
            Math.min(
              matches().length - 1,
              selectedIndex() + (event.key === "ArrowDown" ? 1 : -1),
            ),
          );
          setHighlighted(matches()[index]?.name);
          return;
        }
        if (selected() && (event.key === "Enter" || event.key === "Tab")) {
          event.preventDefault();
          const item = selected();
          if (item && !event.repeat) selectItem(item);
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!event.repeat) props.onSubmit();
    }
  }
  return (
    <>
      <Show when={open()}>
        <SlashCommandMenu
          id={listId}
          input={input?.dom}
          anchor={props.menuAnchor ?? input?.dom}
          commands={matches()}
          hasCommands={
            filesOpen() ? paths().length > 0 : (props.commands?.length ?? 0) > 0
          }
          files={filesOpen()}
          status={
            filesOpen()
              ? loading()
                ? t("thread.loadingFiles")
                : searchFailed()
                  ? t("thread.searchFilesFailed")
                  : matches().length === 0
                    ? t("thread.noMatchingFiles")
                    : undefined
              : undefined
          }
          selected={selected()?.name}
          onSelect={selectItem}
          onHighlight={setHighlighted}
          onDismiss={() => setRequested(false)}
        />
      </Show>
      <div class="flex items-start gap-2">
        <Show when={selectedCommand()}>
          {(name) => (
            <span class="inline-flex max-w-1/2 shrink-0 items-center rounded-md bg-command/10 px-1.5 py-0.5 text-sm leading-5 text-command">
              <button
                type="button"
                class="inline-flex min-w-0 items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-current"
                title={name()}
                aria-label={t("thread.editCommand", { name: name() })}
                disabled={props.disabled}
                onClick={editSelectedCommand}
              >
                <Sparkles aria-hidden="true" class="size-3.5 shrink-0" />
                <span class="min-w-0 truncate">{name()}</span>
              </button>
            </span>
          )}
        </Show>
        <PromptEditor
          value={visibleValue()}
          mentions={visibleMentions()}
          commands={visibleCommands()}
          disabled={props.disabled}
          scope={props.focusScope}
          label={t("thread.message")}
          placeholder={
            selectedCommand()
              ? (hint() ?? t("thread.messagePlaceholder"))
              : t("thread.messagePlaceholder")
          }
          hasCompletion={props.commands !== undefined || filesOpen()}
          expanded={open()}
          listId={open() ? listId : undefined}
          activeDescendant={
            open() && selected() ? `${listId}-${selectedIndex()}` : undefined
          }
          ref={(handle) => {
            input = handle;
            props.inputRef?.(handle);
            if (typeof ResizeObserver !== "undefined") {
              let width = -1;
              const { observe } = makeResizeObserver((entries) => {
                const next = entries[0]?.contentRect.width ?? 0;
                if (next !== width) {
                  width = next;
                  resizeInput();
                }
              });
              observe(handle.dom);
            }
            resizeInput();
          }}
          onInput={(handle, mentions, commands) =>
            batch(() => {
              const name = selectedCommand();
              const prefix = name ? `/${name} ` : "";
              const tokens = commands.map((c) => ({
                ...c,
                start: c.start + prefix.length,
                end: c.end + prefix.length,
              }));
              props.onInput(
                prefix + handle.value,
                name,
                mentions.map((m) => ({
                  ...m,
                  start: m.start + prefix.length,
                  end: m.end + prefix.length,
                })),
                tokens,
              );
              syncSelection();
              setRequested(
                commandQuery(
                  handle.value,
                  handle.selectionStart,
                  handle.selectionEnd,
                ) !== undefined ||
                  mentionQuery(
                    handle.value,
                    handle.selectionStart,
                    handle.selectionEnd,
                    mentions,
                  ) !== undefined,
              );
              setHighlighted(undefined);
              resizeInput();
            })
          }
          onSelect={syncSelection}
          onKeyDown={onKeyDown}
          onBlur={() => setRequested(false)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => {
            setComposing(false);
            syncSelection();
          }}
          onPaste={(event) => {
            const clipboard = event.clipboardData;
            if (!clipboard || clipboard.getData("text/plain")) return;
            const image = [...clipboard.files].find((file) =>
              file.type.startsWith("image/"),
            );
            if (!image) return;
            event.preventDefault();
            if (props.onPasteImage) props.onPasteImage(image);
            else props.onUnsupportedImagePaste?.();
          }}
        />
      </div>
    </>
  );
}
