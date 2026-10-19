import { TriangleAlert } from "lucide-solid";
import type { JSX } from "solid-js";

export function Callout(props: { title: string; children: JSX.Element }) {
  return (
    <div
      role="note"
      aria-label={props.title}
      class="flex gap-3 rounded-lg border border-danger/25 bg-danger-soft p-3 text-sm text-ink dark:bg-danger/10"
    >
      <TriangleAlert
        aria-hidden="true"
        class="mt-0.5 size-4 shrink-0 text-danger dark:text-ink"
      />
      <div class="min-w-0 space-y-1">
        <p class="font-medium">{props.title}</p>
        <div class="text-sm leading-relaxed">{props.children}</div>
      </div>
    </div>
  );
}
