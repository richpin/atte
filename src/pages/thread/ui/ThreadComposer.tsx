import type { AgentAuthenticationState } from "features/agent-authentication";
import {
  ArrowUp,
  AudioLines,
  File as FileIcon,
  Image as ImageIcon,
  Plus,
} from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectSection,
  SelectTrigger,
  SelectValue,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
  Switch as ToggleSwitch,
} from "shared/ui";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import type {
  Attachment,
  MediaKind,
  Thread,
  ThreadConfiguration,
  ThreadConfigurationChoice,
  ThreadConfigurationValue,
} from "../model/types";
import { AttachmentChip } from "./AttachmentChip";
import { PermissionInput } from "./PermissionInput";
import { PromptInput } from "./PromptInput";
import { QueuedMessage } from "./QueuedMessage";

export function ThreadComposer(props: {
  active: boolean;
  thread: Thread;
  draft: string;
  draftAttachments?: Attachment[];
  attachmentErrors?: string[];
  answerPending: boolean;
  cancelPending: boolean;
  showStop: boolean;
  stopping: boolean;
  actionsEnabled: boolean;
  canSend: boolean;
  authentication?: AgentAuthenticationState;
  onDraftChange: (message: string) => void;
  onSelectFiles?: () => void;
  onSelectMedia?: (kind: MediaKind) => void;
  onPasteImage?: (image: File) => void;
  onUnsupportedImagePaste?: () => void;
  onRemoveAttachment?: (id: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onAnswer: (request: string, option: string) => void;
  onConfigure: (configId: string, value: ThreadConfigurationValue) => void;
  onDeleteQueued: (id: string) => Promise<void>;
  onRetryQueued: (id: string) => Promise<void>;
  onRetryAuthentication?: () => void;
  onAuthenticate?: (method: string) => void;
  onCancelAuthentication?: () => void;
}) {
  const { t } = useI18n();
  const authentication = (): AgentAuthenticationState =>
    props.authentication ?? { status: "idle" };
  const authenticationState = <
    Status extends AgentAuthenticationState["status"],
  >(
    status: Status,
  ) => {
    const current = authentication();
    return current.status === status
      ? (current as Extract<AgentAuthenticationState, { status: Status }>)
      : undefined;
  };

  return (
    <div class="max-h-thread-composer mx-auto flex w-full max-w-4xl flex-col overflow-hidden px-6">
      <QueuedMessage
        messages={props.thread.queuedMessages ?? []}
        disabled={!props.actionsEnabled}
        onDelete={props.onDeleteQueued}
        onRetry={props.onRetryQueued}
      />
      <Show
        when={props.thread.failure === "authenticationRequired"}
        fallback={
          <form
            class="max-h-thread-composer-form shrink-0 overflow-y-auto overscroll-contain rounded-3xl border border-line bg-input-surface p-4 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              props.onSend();
            }}
          >
            <Show
              when={props.thread.permissions?.[0]}
              fallback={
                <>
                  <Show when={(props.draftAttachments?.length ?? 0) > 0}>
                    <div class="mb-3 flex flex-wrap gap-2">
                      <For each={props.draftAttachments}>
                        {(attachment) => (
                          <AttachmentChip
                            name={attachment.name}
                            kind={attachment.kind}
                            onRemove={() =>
                              props.onRemoveAttachment?.(attachment.id)
                            }
                          />
                        )}
                      </For>
                    </div>
                  </Show>
                  <PromptInput
                    value={props.draft}
                    disabled={!props.canSend}
                    focusKey={
                      props.active && props.thread.status === "sessionReady"
                        ? props.thread.id
                        : undefined
                    }
                    onInput={props.onDraftChange}
                    onSubmit={props.onSend}
                    onPasteImage={
                      props.thread.promptCapabilities?.image
                        ? props.onPasteImage
                        : undefined
                    }
                    onUnsupportedImagePaste={props.onUnsupportedImagePaste}
                  />
                </>
              }
            >
              {(request) => (
                <PermissionInput
                  request={request()}
                  workingFolder={props.thread.workingFolder}
                  disabled={
                    !props.actionsEnabled ||
                    props.answerPending ||
                    props.cancelPending
                  }
                  onAnswer={props.onAnswer}
                />
              )}
            </Show>
            <div class="mt-3 flex items-end justify-between gap-3 text-xs text-muted">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <DropdownMenu placement="top-start">
                  <DropdownMenuTrigger
                    aria-label={t("thread.addAttachment")}
                    disabled={!props.canSend}
                    class="grid size-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
                  >
                    <Plus
                      aria-hidden="true"
                      size={16}
                      style={{ "stroke-width": "2.5px" }}
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem
                      class="px-3 py-2"
                      onSelect={() => props.onSelectFiles?.()}
                    >
                      <FileIcon aria-hidden="true" class="size-3.5" />
                      {t("thread.file")}
                    </DropdownMenuItem>
                    <Show when={props.thread.promptCapabilities?.image}>
                      <DropdownMenuItem
                        class="px-3 py-2"
                        onSelect={() => props.onSelectMedia?.("image")}
                      >
                        <ImageIcon aria-hidden="true" class="size-3.5" />
                        {t("thread.image")}
                      </DropdownMenuItem>
                    </Show>
                    <Show when={props.thread.promptCapabilities?.audio}>
                      <DropdownMenuItem
                        class="px-3 py-2"
                        onSelect={() => props.onSelectMedia?.("audio")}
                      >
                        <AudioLines aria-hidden="true" class="size-3.5" />
                        {t("thread.audio")}
                      </DropdownMenuItem>
                    </Show>
                  </DropdownMenuContent>
                </DropdownMenu>
                <For each={props.thread.configuration}>
                  {(configuration) => (
                    <ThreadConfigurationControl
                      configuration={configuration}
                      disabled={!props.actionsEnabled}
                      onChange={(value) =>
                        props.onConfigure(configuration.id, value)
                      }
                    />
                  )}
                </For>
              </div>
              <button
                type={props.showStop ? "button" : "submit"}
                aria-label={
                  props.showStop ? t("thread.stop") : t("thread.send")
                }
                class="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
                disabled={
                  props.showStop
                    ? !props.actionsEnabled || props.stopping
                    : !props.canSend ||
                      (!props.draft.trim() &&
                        !(props.draftAttachments?.length ?? 0))
                }
                onClick={() => {
                  if (props.showStop) props.onCancel();
                }}
              >
                <Show
                  when={props.showStop}
                  fallback={<ArrowUp aria-hidden="true" class="size-[18px]" />}
                >
                  <span
                    aria-hidden="true"
                    class="size-3 rounded-[2px] bg-current"
                  />
                </Show>
              </button>
            </div>
          </form>
        }
      >
        <section class="shrink-0 rounded-3xl border border-line bg-input-surface p-4 shadow-sm">
          <Switch>
            <Match when={authenticationState("loading")}>
              <p role="status">{t("thread.authentication.loading")}</p>
            </Match>
            <Match when={authenticationState("error")}>
              <button
                type="button"
                class="mt-3 rounded-lg bg-primary px-4 py-2 text-primary-foreground text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                onClick={() => props.onRetryAuthentication?.()}
              >
                {t("common.retry")}
              </button>
            </Match>
            <Match when={authenticationState("ready")}>
              {(state) => (
                <div class="space-y-3">
                  <For each={state().methods}>
                    {(method) => (
                      <div>
                        <button
                          type="button"
                          class="w-full rounded-lg bg-primary px-4 py-2 text-primary-foreground text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                          onClick={() => props.onAuthenticate?.(method.id)}
                        >
                          {method.name}
                        </button>
                        <Show when={method.description}>
                          {(description) => (
                            <p class="mt-1 text-xs text-muted">
                              {description()}
                            </p>
                          )}
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </Match>
            <Match when={authenticationState("authenticating")}>
              {(state) => (
                <div class="flex items-center justify-between gap-4">
                  <p role="status">
                    {t("thread.authentication.inProgress", {
                      method: state().method.name,
                    })}
                  </p>
                  <button
                    type="button"
                    class="rounded-lg border border-line px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                    onClick={() => props.onCancelAuthentication?.()}
                  >
                    {t("thread.authentication.cancel")}
                  </button>
                </div>
              )}
            </Match>
          </Switch>
        </section>
      </Show>
    </div>
  );
}

function ThreadConfigurationControl(props: {
  configuration: ThreadConfiguration;
  disabled: boolean;
  onChange: (value: ThreadConfigurationValue) => void;
}) {
  const { t } = useI18n();
  const [selectOpen, setSelectOpen] = createSignal(false);
  const selectedName = () => {
    if (props.configuration.type === "boolean")
      return props.configuration.currentValue
        ? t("thread.settingOn")
        : t("thread.settingOff");
    return configurationChoices(props.configuration).find(
      (choice) => choice.value === props.configuration.currentValue,
    )?.name;
  };

  return (
    <div class="min-w-0">
      <Show
        when={props.configuration.type === "select" && props.configuration}
        fallback={
          <ToggleSwitch
            class="flex items-center gap-2"
            checked={
              props.configuration.type === "boolean" &&
              props.configuration.currentValue
            }
            disabled={props.disabled}
            onChange={(value) => props.onChange({ type: "boolean", value })}
          >
            <SwitchControl title={props.configuration.description ?? undefined}>
              <SwitchThumb />
            </SwitchControl>
            <SwitchLabel class="text-xs font-normal">
              {`${props.configuration.name}: ${selectedName()}`}
            </SwitchLabel>
          </ToggleSwitch>
        }
      >
        {(configuration) => (
          <Select<ThreadConfigurationChoice, ThreadConfigurationGroup>
            modal={false}
            onOpenChange={setSelectOpen}
            options={
              configuration().options.type === "grouped"
                ? groupedConfigurationOptions(configuration())
                : flatConfigurationOptions(configuration())
            }
            optionValue="value"
            optionTextValue="name"
            optionGroupChildren="options"
            value={
              configurationChoices(configuration()).find(
                (choice) => choice.value === configuration().currentValue,
              ) ?? null
            }
            disabled={props.disabled}
            placement="top-start"
            onChange={(choice) => {
              if (
                !choice ||
                !selectOpen() ||
                choice.value === configuration().currentValue
              )
                return;
              queueMicrotask(() =>
                props.onChange({ type: "select", value: choice.value }),
              );
            }}
            itemComponent={(itemProps) => (
              <SelectItem
                item={itemProps.item}
                title={itemProps.item.rawValue.description ?? undefined}
              >
                {itemProps.item.rawValue.name}
              </SelectItem>
            )}
            sectionComponent={(sectionProps) => (
              <SelectSection class="px-2 py-1 text-xs font-medium text-muted">
                {sectionProps.section.rawValue.name}
              </SelectSection>
            )}
          >
            <SelectLabel class="sr-only">{configuration().name}</SelectLabel>
            <SelectTrigger
              title={configuration().description ?? undefined}
              class="h-7 w-auto max-w-44 gap-2 border-line bg-input-surface px-2 py-1 text-ink"
            >
              <SelectValue<ThreadConfigurationChoice> class="truncate">
                {(state) =>
                  state.selectedOption()?.name ?? configuration().currentValue
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent class="max-h-64 overflow-y-auto border-line bg-menu text-ink" />
          </Select>
        )}
      </Show>
    </div>
  );
}

type ThreadConfigurationGroup = {
  id: string;
  name: string;
  options: ThreadConfigurationChoice[];
};

function flatConfigurationOptions(
  configuration: Extract<ThreadConfiguration, { type: "select" }>,
) {
  return configuration.options.type === "flat"
    ? configuration.options.options
    : [];
}

function groupedConfigurationOptions(
  configuration: Extract<ThreadConfiguration, { type: "select" }>,
) {
  return configuration.options.type === "grouped"
    ? configuration.options.groups
    : [];
}

function configurationChoices(
  configuration: Extract<ThreadConfiguration, { type: "select" }>,
): ThreadConfigurationChoice[] {
  return configuration.options.type === "flat"
    ? configuration.options.options
    : configuration.options.groups.flatMap((group) => group.options);
}
