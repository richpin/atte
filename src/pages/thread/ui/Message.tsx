import { ChevronDown } from "lucide-solid";
import type { PreparedFileChange } from "shared/diff";
import { type TranslationKey, useI18n } from "shared/i18n";
import { AgentIcon, Markdown } from "shared/ui";
import {
  createSignal,
  For,
  Index,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import type { Attachment, ResponsePart, Turn } from "../model/types";
import { AttachmentChip } from "./AttachmentChip";
import { Plan } from "./Plan";
import { PlanContent } from "./PlanContent";
import { Thought } from "./Thought";
import { ToolCall } from "./ToolCall";
import { TurnChangesSummary } from "./TurnChangesSummary";

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
            <Markdown source={props.message} variant="user" streaming={false} />
          </Show>
        </div>
      </div>
      <Show when={props.attachments.length > 0}>
        <div
          class={
            props.message ? "mt-3 flex flex-wrap gap-2" : "flex flex-wrap gap-2"
          }
        >
          <For each={props.attachments}>
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
        ? "thread.status.waitingForApproval"
        : "thread.status.running",
    );
  return (
    <ol aria-label={t("thread.messages")} class="flex flex-col gap-8">
      <Index each={props.turns}>
        {(turn) => (
          <li class="flex min-w-0 flex-col gap-5 [&>:is([data-tool-call],[data-thought])+:is([data-tool-call],[data-thought])]:-mt-4">
            <UserMessage
              message={turn().message}
              attachments={turn().attachments ?? []}
            />
            <Index each={turn().responseParts}>
              {(part, index) => (
                <Switch>
                  <Match
                    when={
                      part().kind === "thought" &&
                      (part() as Extract<ResponsePart, { kind: "thought" }>)
                    }
                  >
                    {(thought) => (
                      <Thought
                        part={thought()}
                        active={
                          turn().id === props.thinkingTurnId &&
                          index === turn().responseParts.length - 1
                        }
                      />
                    )}
                  </Match>
                  <Match
                    when={
                      part().kind === "plan" &&
                      (part() as Extract<ResponsePart, { kind: "plan" }>)
                    }
                  >
                    {(plan) => (
                      <Plan
                        plan={plan().plan}
                        active={turn().id === props.streamingTurnId}
                      />
                    )}
                  </Match>
                  <Match
                    when={
                      part().kind === "planContent" &&
                      (part() as Extract<ResponsePart, { kind: "planContent" }>)
                    }
                  >
                    {(plan) => (
                      <PlanContent
                        part={plan()}
                        active={turn().id === props.streamingTurnId}
                      />
                    )}
                  </Match>
                  <Match
                    when={
                      part().kind === "tool" &&
                      (part() as Extract<ResponsePart, { kind: "tool" }>)
                    }
                  >
                    {(tool) => (
                      <ToolCall
                        tool={tool().tool}
                        active={turn().id === props.streamingTurnId}
                        interrupted={
                          turn().stopReason === "cancelled" ||
                          (turn().id === props.turns.at(-1)?.id &&
                            props.interrupted)
                        }
                        approvalPending={
                          props.permissionToolIds?.includes(tool().id) ?? false
                        }
                      />
                    )}
                  </Match>
                  <Match
                    when={
                      part().kind === "text" &&
                      (part() as Extract<ResponsePart, { kind: "text" }>)
                    }
                  >
                    {(text) => (
                      <div
                        data-message-participant="agent"
                        data-thread-search-root=""
                        class="w-full min-w-0 text-left text-sm"
                      >
                        <Markdown
                          source={text().text}
                          variant="agent"
                          streaming={
                            turn().id === props.streamingTurnId &&
                            index === turn().responseParts.length - 1
                          }
                          generation={text().id}
                        />
                      </div>
                    )}
                  </Match>
                </Switch>
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
