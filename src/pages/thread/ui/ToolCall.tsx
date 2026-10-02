import {
  Check,
  ChevronDown,
  Circle,
  FilePen,
  FileText,
  Globe,
  LoaderCircle,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "shared/ui";
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
          ? LoaderCircle
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
  const failureSummary = () => {
    if (props.tool.status !== "failed") return undefined;
    const text = textContent().length
      ? textContent().join("\n")
      : typeof props.tool.rawOutput === "string"
        ? props.tool.rawOutput
        : "";
    return text.split("\n").find((line) => line.trim());
  };
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
      class="min-w-0 rounded-lg border border-line text-sm"
    >
      <CollapsibleTrigger class="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <ChevronDown
          aria-hidden="true"
          class="size-3.5 shrink-0 text-muted"
          classList={{ "-rotate-90": !expanded() }}
        />
        <Dynamic
          component={icon()}
          aria-hidden="true"
          class="size-4 shrink-0 text-muted"
        />
        <span class="min-w-0 flex-1 truncate" title={props.tool.title}>
          {props.tool.title || t("thread.tool.fallbackTitle")}
        </span>
        <Dynamic
          component={statusIcon()}
          aria-hidden="true"
          class="size-3.5 shrink-0"
          classList={{
            "animate-spin motion-reduce:animate-none": spinning(),
            "text-response-warning": props.tool.status === "failed",
            "text-muted": props.tool.status !== "failed",
          }}
        />
        <span class="shrink-0 text-xs text-muted">{status()}</span>
      </CollapsibleTrigger>
      <Show when={failureSummary()}>
        <p
          class="truncate px-3 pb-2 text-xs text-response-warning"
          title={failureSummary()}
        >
          {failureSummary()}
        </p>
      </Show>
      <CollapsibleContent class="flex min-w-0 flex-col gap-3 border-t border-line px-3 py-3">
        <Show when={plainValue(props.tool.rawInput)}>
          {(input) => (
            <section>
              <p class="mb-1 text-xs text-muted">{t("thread.tool.input")}</p>
              <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                {input()}
              </pre>
            </section>
          )}
        </Show>
        <Show when={output()}>
          {(result) => (
            <section>
              <p class="mb-1 text-xs text-muted">{t("thread.tool.output")}</p>
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
