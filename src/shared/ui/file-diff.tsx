import {
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import type { PreparedComparison } from "../diff";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { Button } from "./button";
import type { createFileDiffRenderer } from "./file-diff-renderer";

export function FileDiff(props: {
  comparison: Pick<PreparedComparison, "diff"> &
    Partial<Pick<PreparedComparison, "before" | "after">>;
  fallback?: string;
  scrollRoot: () => HTMLElement;
  scrollContent: () => HTMLElement;
  visible: boolean;
}) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const [module] = createResource(() => import("./file-diff-renderer"));
  const [renderer, setRenderer] =
    createSignal<Awaited<ReturnType<typeof createFileDiffRenderer>>>();
  const [failed, setFailed] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const hasContext = () => {
    const diff = props.comparison.diff;
    if (diff.isPartial) return false;
    const last = diff.hunks.at(-1);
    return (
      diff.hunks.some((hunk) => hunk.collapsedBefore > 1) ||
      Boolean(
        last &&
          (diff.additionLines.length -
            last.additionLineIndex -
            last.additionCount >
            1 ||
            diff.deletionLines.length -
              last.deletionLineIndex -
              last.deletionCount >
              1),
      )
    );
  };
  let container!: HTMLDivElement;

  createEffect(() => {
    if (module.error) return;
    const loaded = module();
    const comparison = props.comparison;
    const scrollRoot = props.scrollRoot();
    const scrollContent = props.scrollContent();
    if (!loaded) return;
    let disposed = false;
    let current: Awaited<ReturnType<typeof createFileDiffRenderer>> | undefined;
    setFailed(false);
    void loaded
      .createFileDiffRenderer(
        container,
        scrollRoot,
        scrollContent,
        comparison.diff,
        untrack(resolvedTheme),
      )
      .then((instance) => {
        if (disposed) instance.dispose();
        else {
          current = instance;
          setRenderer(instance);
        }
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    onCleanup(() => {
      disposed = true;
      setRenderer(undefined);
      current?.dispose();
    });
  });
  createEffect(() => {
    const instance = renderer();
    const theme = resolvedTheme();
    if (instance) {
      instance.setTheme(theme);
      if (props.visible) instance.refresh();
    }
  });
  createEffect(() => renderer()?.setExpanded(expanded()));

  return (
    <div class="min-w-0">
      <Show when={!failed() && !module.error && hasContext()}>
        <div class="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!renderer()}
            aria-pressed={expanded()}
            onClick={() => setExpanded((value) => !value)}
          >
            {t(expanded() ? "diff.showChangesOnly" : "diff.showFullCode")}
          </Button>
        </div>
      </Show>
      <Show when={module.loading}>
        <p role="status" class="px-3 py-2 text-xs text-muted">
          {t("diff.loading")}
        </p>
      </Show>
      <Show when={failed() || module.error}>
        <p role="alert" class="px-3 py-2 text-xs text-muted">
          {t("diff.failed")}
        </p>
        <pre class="overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-xs">
          {props.fallback ??
            `${props.comparison.before ?? ""}\n→\n${props.comparison.after ?? ""}`}
        </pre>
      </Show>
      <div ref={container} />
    </div>
  );
}
