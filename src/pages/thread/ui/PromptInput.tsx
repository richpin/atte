import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { useI18n } from "shared/i18n";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onMount,
  Show,
} from "solid-js";
import {
  commandName,
  commandQuery,
  completeCommand,
  matchingCommands,
} from "../model/slash-commands";
import type { AvailableCommand } from "../model/types";
import { SlashCommandMenu } from "./SlashCommandMenu";

const minimumLines = 2;
const maximumLines = 10;
const fallbackLineHeight = 20;

export function PromptInput(props: {
  value: string;
  selectedCommand?: string;
  commands?: AvailableCommand[];
  menuAnchor?: HTMLElement;
  focusScope?: string;
  disabled: boolean;
  focusKey?: string;
  inputRef?: (element: HTMLTextAreaElement) => void;
  onInput: (value: string, command?: string) => void;
  onSubmit: () => void;
  onPasteImage?: (image: File) => void;
  onUnsupportedImagePaste?: () => void;
}) {
  const { t } = useI18n();
  let input: HTMLTextAreaElement | undefined;
  const listId = createUniqueId();
  const [selection, setSelection] = createSignal({ start: 0, end: 0 });
  const [requested, setRequested] = createSignal(false);
  const [composing, setComposing] = createSignal(false);
  const [highlighted, setHighlighted] = createSignal<string>();
  const selectedCommand = () =>
    props.selectedCommand && commandName(props.value) === props.selectedCommand
      ? props.selectedCommand
      : undefined;
  const visibleValue = () => {
    const name = selectedCommand();
    if (!name) return props.value;
    const body = props.value.slice(name.length + 1);
    return body.startsWith(" ") ? body.slice(1) : body;
  };
  const query = () =>
    selectedCommand()
      ? undefined
      : commandQuery(props.value, selection().start, selection().end);
  const open = () =>
    requested() &&
    props.commands !== undefined &&
    !props.disabled &&
    !composing() &&
    query() !== undefined;
  const matches = createMemo(() =>
    matchingCommands(props.commands ?? [], query() ?? ""),
  );
  const selected = () =>
    matches().find((command) => command.name === highlighted()) ?? matches()[0];
  const selectedIndex = () =>
    matches().findIndex((command) => command.name === selected()?.name);
  const hint = () =>
    (props.commands ?? []).find(
      (command) => command.name === commandName(props.value),
    )?.inputHint;

  function syncSelection() {
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    setSelection({ start, end });
    if (commandQuery(input.value, start, end) === undefined)
      setRequested(false);
  }

  function selectCommand(command: AvailableCommand) {
    const completed = completeCommand(props.value, command.name);
    setRequested(false);
    props.onInput(completed.value, command.name);
    input?.focus();
    const cursor = selectedCommand() ? 0 : completed.cursor;
    input?.setSelectionRange(cursor, cursor);
    syncSelection();
    resizeInput();
  }

  function editSelectedCommand() {
    const name = selectedCommand();
    if (!name) return;
    props.onInput(props.value);
    input?.focus();
    input?.setSelectionRange(name.length + 1, name.length + 1);
    syncSelection();
    setRequested(true);
  }

  function removeSelectedCommand() {
    props.onInput(visibleValue());
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
    if (!matches().some((command) => command.name === highlighted())) {
      setHighlighted(undefined);
    }
  });

  function resizeInput() {
    if (!input) return;
    const styles = getComputedStyle(input);
    const measuredLineHeight = Number.parseFloat(styles.lineHeight);
    const lineHeight = Number.isFinite(measuredLineHeight)
      ? measuredLineHeight
      : fallbackLineHeight;
    const pixels = (value: string) => Number.parseFloat(value) || 0;
    const padding = pixels(styles.paddingTop) + pixels(styles.paddingBottom);
    const border =
      pixels(styles.borderTopWidth) + pixels(styles.borderBottomWidth);
    const minimumHeight = lineHeight * minimumLines + padding + border;
    const maximumHeight = lineHeight * maximumLines + padding + border;
    input.style.height = "0px";
    input.style.height = `${Math.min(
      Math.max(input.scrollHeight + border, minimumHeight),
      maximumHeight,
    )}px`;
  }

  createEffect(
    on(
      () => props.focusKey,
      (focusKey) => {
        if (focusKey) input?.focus();
      },
    ),
  );
  createEffect(
    on(
      () => [props.value, props.selectedCommand] as const,
      () => queueMicrotask(resizeInput),
    ),
  );
  onMount(() => {
    if (typeof ResizeObserver !== "undefined") {
      let width = -1;
      const { observe } = makeResizeObserver((entries) => {
        const nextWidth =
          entries[0]?.contentRect.width ?? input?.clientWidth ?? 0;
        if (nextWidth === width) return;
        width = nextWidth;
        resizeInput();
      });
      if (input) observe(input);
    }
    resizeInput();
  });

  return (
    <>
      <Show when={open()}>
        <SlashCommandMenu
          id={listId}
          input={input}
          anchor={props.menuAnchor ?? input}
          commands={matches()}
          hasCommands={(props.commands?.length ?? 0) > 0}
          selected={selected()?.name}
          onSelect={selectCommand}
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
                class="min-w-0 truncate rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-current"
                title={name()}
                aria-label={t("thread.editCommand", { name: name() })}
                disabled={props.disabled}
                onClick={editSelectedCommand}
              >
                {name()}
              </button>
            </span>
          )}
        </Show>
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Completion conditionally supplies the combobox role. */}
        <textarea
          ref={(element) => {
            input = element;
            props.inputRef?.(element);
          }}
          role={props.commands ? "combobox" : undefined}
          aria-autocomplete={props.commands ? "list" : undefined}
          aria-haspopup={props.commands ? "listbox" : undefined}
          aria-expanded={props.commands ? open() : undefined}
          aria-controls={open() ? listId : undefined}
          aria-activedescendant={
            open() && selected() ? `${listId}-${selectedIndex()}` : undefined
          }
          aria-label={t("thread.message")}
          class="max-h-thread-composer-input min-w-0 w-full flex-1 resize-none overflow-y-auto overscroll-contain bg-transparent text-sm leading-5 outline-none disabled:cursor-not-allowed"
          disabled={props.disabled}
          value={visibleValue()}
          onInput={(event) => {
            const element = event.currentTarget;
            const value = element.value;
            const start = element.selectionStart;
            const end = element.selectionEnd;
            const name = selectedCommand();
            props.onInput(name ? `/${name} ${value}` : value, name);
            // Updating a controlled textarea can move its caret to the end.
            element.setSelectionRange(start, end);
            syncSelection();
            if (!name && commandQuery(value, start, end) !== undefined) {
              setRequested(true);
              setHighlighted(undefined);
            }
            resizeInput();
          }}
          onSelect={syncSelection}
          onClick={syncSelection}
          onKeyUp={syncSelection}
          onBlur={() => setRequested(false)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => {
            setComposing(false);
            syncSelection();
          }}
          onPaste={(event) => {
            const clipboard = event.clipboardData;
            if (!clipboard || clipboard.getData("text/plain").length > 0)
              return;
            const image = [...clipboard.files].find((file) =>
              file.type.startsWith("image/"),
            );
            if (!image) return;
            event.preventDefault();
            if (props.onPasteImage) props.onPasteImage(image);
            else props.onUnsupportedImagePaste?.();
          }}
          onKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229 || composing())
              return;
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
                selected() &&
                !event.shiftKey &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey
              ) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const offset = event.key === "ArrowDown" ? 1 : -1;
                  const index = Math.max(
                    0,
                    Math.min(matches().length - 1, selectedIndex() + offset),
                  );
                  setHighlighted(matches()[index]?.name);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  if (!event.repeat) selectCommand(selected());
                  return;
                }
              }
            }
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.isComposing ||
              event.keyCode === 229
            )
              return;
            event.preventDefault();
            if (!event.repeat) props.onSubmit();
          }}
          rows={2}
          placeholder={
            selectedCommand()
              ? (hint() ?? t("thread.messagePlaceholder"))
              : t("thread.messagePlaceholder")
          }
        />
      </div>
    </>
  );
}
