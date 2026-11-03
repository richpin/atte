import * as Popper from "@kobalte/core/popper";
import { createInteractOutside } from "@kobalte/core/primitives/create-interact-outside";
import { useI18n } from "shared/i18n";
import { FileIcon } from "shared/ui";
import { createEffect, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { AvailableCommand } from "../model/types";

export function SlashCommandMenu(props: {
  id: string;
  input: HTMLElement | undefined;
  anchor: HTMLElement | undefined;
  commands: (AvailableCommand & { path?: string })[];
  files?: boolean;
  status?: string;
  hasCommands: boolean;
  selected: string | undefined;
  onSelect: (command: AvailableCommand) => void;
  onHighlight: (name: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  let content: HTMLDivElement | undefined;
  const items = new Map<string, HTMLButtonElement>();
  createInteractOutside(
    {
      shouldExcludeElement: (element) => element === props.input,
      onInteractOutside: () => props.onDismiss(),
    },
    () => content,
  );
  createEffect(() => {
    const name = props.commands.find(
      (command) => command.name === props.selected,
    )?.name;
    const item = name ? items.get(name) : undefined;
    item?.scrollIntoView?.({ block: "nearest" });
  });

  return (
    <Portal>
      <Popper.Root
        anchorRef={() => props.anchor}
        contentRef={() => content}
        placement="top-start"
        gutter={8}
        sameWidth
        fitViewport
        flip={false}
      >
        <Popper.Positioner style={{ "min-width": "0px" }}>
          <div
            ref={content}
            class="max-h-[min(20rem,var(--kb-popper-content-available-height))] overflow-y-auto overscroll-contain rounded-xl border border-line bg-menu p-1 text-ink shadow-md"
          >
            <div
              id={props.id}
              role="listbox"
              onMouseDown={(event) => event.preventDefault()}
              aria-label={t(
                props.files ? "thread.fileMentions" : "thread.slashCommands",
              )}
            >
              <For each={props.commands}>
                {(command, index) => {
                  onCleanup(() => items.delete(command.name));
                  return (
                    <button
                      type="button"
                      tabIndex={-1}
                      ref={(element) => items.set(command.name, element)}
                      id={`${props.id}-${index()}`}
                      role="option"
                      aria-selected={props.selected === command.name}
                      class="flex w-full cursor-default justify-center rounded-lg px-3 py-2 text-left text-xs"
                      classList={{
                        "flex-row items-center gap-2": props.files,
                        "flex-col": !props.files,
                        "bg-menu-hover": props.selected === command.name,
                      }}
                      onMouseMove={() => props.onHighlight(command.name)}
                      onClick={() => props.onSelect(command)}
                    >
                      <Show
                        when={props.files}
                        fallback={
                          <>
                            <span class="truncate text-sm font-medium">
                              /{command.name}
                            </span>
                            <span
                              class="truncate text-muted"
                              title={command.description}
                            >
                              {command.description}
                            </span>
                          </>
                        }
                      >
                        <FileIcon path={command.name} />
                        <span
                          class="min-w-0 shrink truncate text-sm"
                          title={command.name}
                        >
                          {command.name.split("/").at(-1)}
                        </span>
                        <span
                          class="min-w-0 flex-1 truncate text-xs text-muted"
                          title={command.name}
                        >
                          {command.description}
                        </span>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
            <Show when={props.status || props.commands.length === 0}>
              <p role="status" class="px-3 py-3 text-xs text-muted">
                {props.status ??
                  t(
                    props.hasCommands
                      ? "thread.noMatchingCommands"
                      : "thread.noCommands",
                  )}
              </p>
            </Show>
          </div>
        </Popper.Positioner>
      </Popper.Root>
    </Portal>
  );
}
