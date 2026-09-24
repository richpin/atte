import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { Popover } from "@kobalte/core/popover";
import type { AgentAuthenticationState } from "features/agent-authentication";
import { useI18n } from "shared/i18n";
import { For, Match, Show, Switch } from "solid-js";
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
  agentName: string;
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
  const isPromotedConfiguration = (configuration: ThreadConfiguration) =>
    ["model", "thought_level", "mode"].includes(configuration.category ?? "");
  const promotedConfiguration = () =>
    (props.thread.configuration ?? []).filter(isPromotedConfiguration);
  const additionalConfiguration = () =>
    (props.thread.configuration ?? []).filter(
      (configuration) => !isPromotedConfiguration(configuration),
    );

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
            class="max-h-thread-composer-form shrink-0 overflow-y-auto overscroll-contain rounded-2xl border border-line bg-panel p-4"
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
                  <Show when={(props.attachmentErrors?.length ?? 0) > 0}>
                    <ul role="alert" class="mb-3 text-xs text-danger">
                      <For each={props.attachmentErrors}>
                        {(name) => (
                          <li>{t("thread.fileUnavailable", { name })}</li>
                        )}
                      </For>
                    </ul>
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
            <div class="mt-3 flex items-center justify-between gap-3 text-xs text-muted">
              <div class="flex min-w-0 items-center gap-2">
                <DropdownMenu placement="top-start">
                  <DropdownMenu.Trigger
                    aria-label={t("thread.addAttachment")}
                    disabled={!props.canSend}
                    class="grid size-7 shrink-0 place-items-center rounded-full border border-line text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
                  >
                    +
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="z-50 min-w-32 rounded-lg border border-line bg-panel p-1 text-sm text-ink shadow-lg">
                      <DropdownMenu.Item
                        class="rounded px-3 py-2 outline-none data-[highlighted]:bg-canvas"
                        onSelect={() => props.onSelectFiles?.()}
                      >
                        {t("thread.file")}
                      </DropdownMenu.Item>
                      <Show when={props.thread.promptCapabilities?.image}>
                        <DropdownMenu.Item
                          class="rounded px-3 py-2 outline-none data-[highlighted]:bg-canvas"
                          onSelect={() => props.onSelectMedia?.("image")}
                        >
                          {t("thread.image")}
                        </DropdownMenu.Item>
                      </Show>
                      <Show when={props.thread.promptCapabilities?.audio}>
                        <DropdownMenu.Item
                          class="rounded px-3 py-2 outline-none data-[highlighted]:bg-canvas"
                          onSelect={() => props.onSelectMedia?.("audio")}
                        >
                          {t("thread.audio")}
                        </DropdownMenu.Item>
                      </Show>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
                <span class="shrink-0">{props.agentName}</span>
                <For each={promotedConfiguration()}>
                  {(configuration) => (
                    <ThreadConfigurationControl
                      configuration={configuration}
                      compact
                      disabled={!props.actionsEnabled}
                      onChange={(value) =>
                        props.onConfigure(configuration.id, value)
                      }
                    />
                  )}
                </For>
                <Show when={additionalConfiguration().length > 0}>
                  <Popover placement="top-start">
                    <Popover.Trigger class="rounded-md border border-line px-2 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                      {t("thread.settings")}
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content class="flex min-w-64 flex-col gap-3 rounded-xl border border-line bg-panel p-3 text-xs text-ink shadow-lg">
                        <For each={additionalConfiguration()}>
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
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover>
                </Show>
              </div>
              <button
                type={props.showStop ? "button" : "submit"}
                aria-label={
                  props.showStop ? t("thread.stop") : t("thread.send")
                }
                class="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
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
                  fallback={
                    <svg
                      aria-hidden="true"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.25"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M12 19V5m-7 7 7-7 7 7" />
                    </svg>
                  }
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
        <section class="shrink-0 rounded-2xl border border-line bg-panel p-4">
          <Switch>
            <Match when={authenticationState("loading")}>
              <p role="status">{t("thread.authentication.loading")}</p>
            </Match>
            <Match when={authenticationState("error")}>
              {(state) => (
                <>
                  <p role="alert">{state().message}</p>
                  <button
                    type="button"
                    class="mt-3 rounded-lg bg-accent px-4 py-2 text-sm text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                    onClick={() => props.onRetryAuthentication?.()}
                  >
                    {t("common.retry")}
                  </button>
                </>
              )}
            </Match>
            <Match when={authenticationState("ready")}>
              {(state) => (
                <div class="space-y-3">
                  <For each={state().methods}>
                    {(method) => (
                      <div>
                        <button
                          type="button"
                          class="w-full rounded-lg bg-accent px-4 py-2 text-sm text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
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
  compact?: boolean;
  disabled: boolean;
  onChange: (value: ThreadConfigurationValue) => void;
}) {
  const { t } = useI18n();
  const selectedName = () => {
    if (props.configuration.type === "boolean")
      return props.configuration.currentValue
        ? t("thread.settingOn")
        : t("thread.settingOff");
    return configurationChoices(props.configuration).find(
      (choice) => choice.value === props.configuration.currentValue,
    )?.name;
  };
  const accessibleName = () =>
    `${props.configuration.name}: ${selectedName() ?? props.configuration.currentValue}`;

  return (
    <div class={props.compact ? "min-w-0" : "flex flex-col gap-1"}>
      <Show when={!props.compact}>
        <span class="font-medium">{props.configuration.name}</span>
        <Show when={props.configuration.description}>
          {(description) => (
            <span class="text-xs text-muted">{description()}</span>
          )}
        </Show>
      </Show>
      <Show
        when={props.configuration.type === "select" && props.configuration}
        fallback={
          <button
            type="button"
            role="switch"
            aria-label={accessibleName()}
            title={props.configuration.description ?? undefined}
            aria-checked={
              props.configuration.type === "boolean" &&
              props.configuration.currentValue
            }
            disabled={props.disabled}
            class="rounded-md border border-line px-2 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            onClick={() => {
              if (props.configuration.type === "boolean")
                props.onChange({
                  type: "boolean",
                  value: !props.configuration.currentValue,
                });
            }}
          >
            {props.compact
              ? `${props.configuration.name}: ${selectedName()}`
              : selectedName()}
          </button>
        }
      >
        {(configuration) => (
          <select
            aria-label={accessibleName()}
            title={configuration().description ?? undefined}
            disabled={props.disabled}
            value={configuration().currentValue}
            class="max-w-44 rounded-md border border-line bg-panel px-2 py-1 text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            onChange={(event) =>
              props.onChange({
                type: "select",
                value: event.currentTarget.value,
              })
            }
          >
            <Show
              when={configuration().options.type === "grouped"}
              fallback={
                <For each={flatConfigurationOptions(configuration())}>
                  {(choice) => (
                    <option
                      value={choice.value}
                      title={choice.description ?? undefined}
                    >
                      {choice.name}
                    </option>
                  )}
                </For>
              }
            >
              <For each={groupedConfigurationOptions(configuration())}>
                {(group) => (
                  <optgroup label={group.name} aria-label={group.name}>
                    <For each={group.options}>
                      {(choice) => (
                        <option
                          value={choice.value}
                          title={choice.description ?? undefined}
                        >
                          {choice.name}
                        </option>
                      )}
                    </For>
                  </optgroup>
                )}
              </For>
            </Show>
          </select>
        )}
      </Show>
    </div>
  );
}

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
