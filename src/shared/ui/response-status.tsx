import { Circle, CircleAlert, LoaderCircle } from "lucide-solid";
import { Show } from "solid-js";

export function ResponseStatus(props: {
  kind: "progress" | "complete" | "error" | "approval";
  label: string;
}) {
  return (
    <span
      role="status"
      aria-label={props.label}
      title={props.label}
      class="inline-flex shrink-0 items-center justify-center"
      classList={{
        "text-response-info":
          props.kind === "complete" || props.kind === "approval",
        "text-response-warning": props.kind === "error",
        "text-muted": props.kind === "progress",
        "rounded bg-response-info-soft px-1.5 py-0.5 text-xs":
          props.kind === "approval",
      }}
    >
      <Show when={props.kind === "approval"}>{props.label}</Show>
      <Show when={props.kind === "progress"}>
        <LoaderCircle
          aria-hidden="true"
          class="size-4 animate-spin motion-reduce:animate-none"
          strokeWidth={2}
        />
      </Show>
      <Show when={props.kind === "complete"}>
        <Circle aria-hidden="true" class="size-4" strokeWidth={2} />
      </Show>
      <Show when={props.kind === "error"}>
        <CircleAlert aria-hidden="true" class="size-4" strokeWidth={2} />
      </Show>
    </span>
  );
}
