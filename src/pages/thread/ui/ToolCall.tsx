import {
  Check,
  ChevronDown,
  Circle,
  FilePen,
  FileText,
  Globe,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Tailspin,
} from "shared/ui";
import { createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { ToolCall as ToolCallData, ToolContent } from "../model/types";

function plainValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function ToolCall(props: {
  tool: ToolCallData;
  active: boolean;
  interrupted?: boolean;
  approvalPending: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = createSignal(false);
  const unfinished = () =>
    !["completed", "failed"].includes(props.tool.status ?? "pending");
  const spinning = () =>
    props.active &&
    !props.approvalPending &&
    props.tool.status === "in_progress";
  const status = () => {
    if (props.approvalPending) return t("thread.tool.approval");
    if (!props.active && unfinished())
      return t(
        props.interrupted
          ? "thread.tool.interrupted"
          : "thread.tool.unconfirmed",
      );
    return t(`thread.tool.${props.tool.status ?? "pending"}`);
  };
  const icon = () => {
    switch (props.tool.kind) {
      case "read":
        return FileText;
      case "edit":
      case "delete":
      case "move":
        return FilePen;
      case "search":
        return Search;
      case "execute":
        return Terminal;
      case "fetch":
        return Globe;
      default:
        return Wrench;
    }
  };
  const statusIcon = () =>
    props.tool.status === "failed"
      ? X
      : props.tool.status === "completed"
        ? Check
        : spinning()
          ? Tailspin
          : Circle;
  const textContent = () =>
    (props.tool.content ?? []).flatMap((item) =>
      item.type === "content" &&
      item.content.type === "text" &&
      item.content.text
        ? [item.content.text]
        : [],
    );
  const output = () =>
    textContent().length
      ? textContent().join("\n\n")
      : plainValue(props.tool.rawOutput);
  const placeholder = (item: ToolContent) => {
    if (item.type === "diff") return `${t("thread.tool.diff")}: ${item.path}`;
    if (item.type === "terminal") return t("thread.tool.terminal");
    return `${t("thread.tool.content")}: ${item.content.type}${item.content.name ? ` — ${item.content.name}` : ""}${item.content.uri || item.content.resource?.uri ? ` — ${item.content.uri ?? item.content.resource?.uri}` : ""}`;
  };
  return (
    <Collapsible
      open={expanded()}
      onOpenChange={setExpanded}
      data-tool-call=""
      class="min-w-0 rounded-xl border border-line text-sm"
    >
      <CollapsibleTrigger class="flex w-full min-w-0 items-center gap-2 px-3 py-[4.5px] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <Dynamic
          component={icon()}
          aria-hidden="true"
          class="size-4 shrink-0 text-muted"
        />
        <span class="flex min-w-0 flex-1 items-center gap-2">
          <span class="truncate" title={props.tool.title}>
            {props.tool.title || t("thread.tool.fallbackTitle")}
          </span>
          <ChevronDown
            aria-hidden="true"
            class="size-3.5 shrink-0 text-muted"
            classList={{ "-rotate-90": !expanded() }}
          />
        </span>
        <Dynamic
          component={statusIcon()}
          aria-hidden="true"
          class="inline-flex size-3.5 shrink-0"
          size={14}
          classList={{
            "text-response-warning": props.tool.status === "failed",
            "text-response-success": props.tool.status === "completed",
            "text-muted":
              props.tool.status !== "failed" &&
              props.tool.status !== "completed",
          }}
        />
        <span class="shrink-0 text-xs text-muted">{status()}</span>
      </CollapsibleTrigger>
      <CollapsibleContent
        data-thread-search-root=""
        data-thread-search-hidden={!expanded()}
        class="flex min-w-0 flex-col gap-3 border-t border-line px-3 py-3"
      >
        <Show when={plainValue(props.tool.rawInput)}>
          {(input) => (
            <section>
              <p data-thread-search-ignore="" class="mb-1 text-xs text-muted">
                {t("thread.tool.input")}
              </p>
              <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                {input()}
              </pre>
            </section>
          )}
        </Show>
        <Show when={output()}>
          {(result) => (
            <section>
              <p data-thread-search-ignore="" class="mb-1 text-xs text-muted">
                {t("thread.tool.output")}
              </p>
              <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                {result()}
              </pre>
            </section>
          )}
        </Show>
        <Show when={textContent().length && plainValue(props.tool.rawOutput)}>
          {(raw) => (
            <details>
              <summary class="cursor-pointer text-xs text-muted">
                {t("thread.tool.rawOutput")}
              </summary>
              <pre class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                {raw()}
              </pre>
            </details>
          )}
        </Show>
        <For each={props.tool.locations ?? []}>
          {(location) => (
            <p class="break-all font-mono text-xs text-muted">
              {location.path}
              {location.line != null ? `:${location.line}` : ""}
            </p>
          )}
        </For>
        <For
          each={(props.tool.content ?? []).filter(
            (item) => item.type !== "content" || item.content.type !== "text",
          )}
        >
          {(item) => (
            <p class="break-all text-xs text-muted">{placeholder(item)}</p>
          )}
        </For>
      </CollapsibleContent>
    </Collapsible>
  );
}
