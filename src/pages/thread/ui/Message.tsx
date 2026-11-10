import { ChevronDown } from "lucide-solid";
import type { PreparedFileChange } from "shared/diff";
import { type TranslationKey, useI18n } from "shared/i18n";
import { AgentIcon, Markdown } from "shared/ui";
import {
  type Accessor,
  createSignal,
  For,
  Index,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { attachmentMentions, mentionFileName } from "../model/file-mentions";
import { groupResponseParts } from "../model/response-groups";
import type { Attachment, Turn } from "../model/types";
import { AttachmentChip } from "./AttachmentChip";
import { ResponseParts } from "./ResponseParts";
import { TurnChangesSummary } from "./TurnChangesSummary";
import { WorkLog } from "./WorkLog";

const collapsedLines = 20;

const completionKeys: Record<string, TranslationKey> = {
  end_turn: "thread.completion.end_turn",
  max_tokens: "thread.completion.max_tokens",
  max_turn_requests: "thread.completion.max_turn_requests",
  refusal: "thread.completion.refusal",
  cancelled: "thread.completion.cancelled",
};

function UserMessage(props: { message: string; attachments: Attachment[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = createSignal(false);
  const [collapsible, setCollapsible] = createSignal(false);
  let content!: HTMLDivElement;

  onMount(() => {
    const measure = () => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(content).lineHeight,
      );
      setCollapsible(
        Number.isFinite(lineHeight) &&
          content.scrollHeight > lineHeight * collapsedLines + 0.5,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    measure();
    onCleanup(() => observer.disconnect());
  });

  return (
    <div
      data-message-participant="user"
      class="ml-auto min-w-0 max-w-[85%] rounded-2xl bg-user-bubble px-4 py-3 text-ink text-sm"
    >
      <div
        class={
          collapsible() && !expanded() ? "max-h-[25rem] overflow-hidden" : ""
        }
      >
        <div
          ref={content}
          data-user-message-content=""
          data-thread-search-root=""
          on:thread-search-reveal={() => setExpanded(true)}
        >
          <Show when={props.message}>
            <Markdown
              source={props.message}
              variant="user"
              streaming={false}
              inlineChips={attachmentMentions(props.attachments).map((m) => ({
                start: m.start,
                end: m.end,
                label: `@${m.path}`,
                displayLabel: mentionFileName(m.path),
                title: m.path,
              }))}
            />
          </Show>
        </div>
      </div>
      <Show when={props.attachments.some((a) => !a.resource)}>
        <div
          class={
            props.message ? "mt-3 flex flex-wrap gap-2" : "flex flex-wrap gap-2"
          }
        >
          <For each={props.attachments.filter((a) => !a.resource)}>
            {(attachment) => (
              <AttachmentChip name={attachment.name} kind={attachment.kind} />
            )}
          </For>
        </div>
      </Show>
      <Show when={collapsible()}>
        <button
          type="button"
          aria-expanded={expanded()}
          class="mt-2 flex items-center gap-1 text-muted text-xs hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded() ? t("thread.showLess") : t("thread.showMore")}
          <ChevronDown
            aria-hidden="true"
            class="size-3.5"
            classList={{ "rotate-180": expanded() }}
          />
        </button>
      </Show>
    </div>
  );
}

export function Message(props: {
  turns: Turn[];
  threadId?: string;
  visible?: boolean;
  onOpenFile?: (path: string) => void;
  streamingTurnId?: string;
  thinkingTurnId?: string;
  respondingTurnId?: string;
  agentId?: string;
  approvalPending?: boolean;
  permissionToolIds?: string[];
  interrupted?: boolean;
  changesActiveTurnId?: string;
  onOpenChanges?: (turnId: string, files: PreparedFileChange[]) => void;
}) {
  const { t } = useI18n();
  const responseStatus = () =>
    t(
      props.approvalPending
        ? "thread.status.waitingForInput"
        : "thread.status.running",
    );
  return (
    <ol aria-label={t("thread.messages")} class="flex flex-col gap-8">
      <Index each={props.turns}>
        {(turn) => (
          <li class="flex min-w-0 flex-col gap-5">
            <UserMessage
              message={turn().message}
              attachments={turn().attachments ?? []}
            />
            <Index each={groupResponseParts(turn().responseParts)}>
              {(group) => (
                <Show when={group().id} keyed>
                  {(_id) => {
                    const parts = (visible: Accessor<boolean> = () => true) => (
                      <ResponseParts
                        parts={group().parts}
                        startIndex={group().startIndex}
                        turn={turn()}
                        streaming={turn().id === props.streamingTurnId}
                        thinking={turn().id === props.thinkingTurnId}
                        threadId={props.threadId}
                        visible={props.visible !== false && visible()}
                        onOpenFile={props.onOpenFile}
                        permissionToolIds={props.permissionToolIds}
                        interrupted={
                          turn().stopReason === "cancelled" ||
                          (turn().id === props.turns.at(-1)?.id &&
                            props.interrupted)
                        }
                      />
                    );
                    return (
                      <Show when={group().workLog} fallback={parts()}>
                        <WorkLog
                          count={group().parts.length}
                          collecting={
                            (turn().id === props.streamingTurnId &&
                              group().startIndex + group().parts.length ===
                                turn().responseParts.length) ||
                            group().parts.some((part) =>
                              props.permissionToolIds?.includes(part.id),
                            )
                          }
                        >
                          {(visible) => parts(visible)}
                        </WorkLog>
                      </Show>
                    );
                  }}
                </Show>
              )}
            </Index>
            <TurnChangesSummary
              turn={turn()}
              active={
                turn().id ===
                (props.changesActiveTurnId ?? props.streamingTurnId)
              }
              permissionToolIds={props.permissionToolIds}
              onOpen={props.onOpenChanges}
            />
            <Show when={turn().id === props.respondingTurnId}>
              <div
                role="status"
                aria-label={responseStatus()}
                title={responseStatus()}
                class="grid size-6 place-items-center"
              >
                <span
                  class="inline-flex size-6 items-center justify-center"
                  classList={{
                    "animate-agent-waiting motion-reduce:animate-none":
                      !props.approvalPending,
                  }}
                >
                  <AgentIcon id={props.agentId ?? ""} src={null} waiting />
                </span>
              </div>
            </Show>
            <Show when={turn().stopReason}>
              {(reason) => (
                <p class="text-xs text-muted">
                  {completionKeys[reason()]
                    ? t(completionKeys[reason()])
                    : reason()}
                </p>
              )}
            </Show>
          </li>
        )}
      </Index>
    </ol>
  );
}
