import { Markdown } from "shared/ui";
import { Index, Match, Switch } from "solid-js";
import type { ResponsePart, Turn } from "../model/types";
import { Plan } from "./Plan";
import { PlanContent } from "./PlanContent";
import { ResponseContentView } from "./ResponseContent";
import { Thought } from "./Thought";
import { ToolCall } from "./ToolCall";

export function ResponseParts(props: {
  parts: ResponsePart[];
  startIndex: number;
  turn: Turn;
  streaming: boolean;
  thinking: boolean;
  threadId?: string;
  visible?: boolean;
  onOpenFile?: (path: string) => void;
  permissionToolIds?: string[];
  interrupted?: boolean;
}) {
  return (
    <Index each={props.parts}>
      {(part, index) => (
        <Switch>
          <Match
            when={
              part().kind === "content" &&
              (part() as Extract<ResponsePart, { kind: "content" }>)
            }
          >
            {(content) => (
              <div data-message-participant="agent" data-thread-search-root="">
                <ResponseContentView
                  content={content().content}
                  threadId={props.threadId}
                  visible={props.visible}
                  onOpenFile={props.onOpenFile}
                />
              </div>
            )}
          </Match>
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
                  props.thinking &&
                  props.startIndex + index ===
                    props.turn.responseParts.length - 1
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
            {(plan) => <Plan plan={plan().plan} active={props.streaming} />}
          </Match>
          <Match
            when={
              part().kind === "planContent" &&
              (part() as Extract<ResponsePart, { kind: "planContent" }>)
            }
          >
            {(plan) => <PlanContent part={plan()} active={props.streaming} />}
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
                threadId={props.threadId}
                visible={props.visible}
                onOpenFile={props.onOpenFile}
                active={props.streaming}
                interrupted={props.interrupted}
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
                    props.streaming &&
                    props.startIndex + index ===
                      props.turn.responseParts.length - 1
                  }
                  generation={text().id}
                />
              </div>
            )}
          </Match>
        </Switch>
      )}
    </Index>
  );
}
