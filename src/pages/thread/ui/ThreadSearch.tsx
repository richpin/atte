import { createResizeObserver } from "@solid-primitives/resize-observer";
import { ArrowDown, ArrowUp, X } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Button } from "shared/ui";
import {
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import {
  type SearchRectangle,
  threadMatchRectangles,
} from "../lib/thread-search";
import { createThreadSearch } from "../model/thread-search";

export function ThreadSearch(props: {
  active: boolean;
  scopeKey?: string;
  openRequest?: number;
  content: HTMLElement;
  viewport: HTMLElement;
  bottomInset: number;
  onOpenChange: (open: boolean) => void;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  let input: HTMLInputElement | undefined;
  let bar: HTMLElement | undefined;
  let origin: HTMLElement | undefined;
  let composing = false;
  let focusFrame: number | undefined;
  let paintFrame: number | undefined;
  const [rectangles, setRectangles] = createSignal<SearchRectangle[]>([]);
  const nativeHighlights =
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined";
  const search = createThreadSearch({
    content: () => props.content,
    viewport: () => props.viewport,
    bottomInset: () => props.bottomInset,
    topInset: () => (bar?.offsetHeight ?? 40) + 24,
    onNavigate: () => props.onNavigate(),
  });
  createEffect(() => props.onOpenChange(search.open()));

  function show() {
    if (!props.active) return;
    if (!search.open()) {
      const focused = document.activeElement;
      const menu = focused?.closest('[role="menu"]');
      origin =
        (menu &&
          document.getElementById(
            menu.getAttribute("aria-labelledby") ?? "",
          )) ||
        (focused instanceof HTMLElement ? focused : props.viewport);
    }
    search.show();
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    // Wait until the search input has mounted before focusing it.
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined;
      input?.focus({ preventScroll: true });
      input?.select();
    });
  }

  function close() {
    search.close();
    composing = false;
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    focusFrame = undefined;
    (origin?.isConnected ? origin : props.viewport).focus({
      preventScroll: true,
    });
  }

  let lastRequest = props.openRequest ?? 0;
  createEffect(() => {
    const request = props.openRequest ?? 0;
    if (request === lastRequest) return;
    lastRequest = request;
    untrack(show);
  });
  createEffect(
    on(
      () => [props.scopeKey, props.active] as const,
      () => {
        search.reset();
        composing = false;
        if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
        focusFrame = undefined;
      },
    ),
  );

  onMount(() => {
    function keydown(event: KeyboardEvent) {
      if (!props.active || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
        return;
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        show();
      } else if (search.open() && event.key === "Escape") {
        event.preventDefault();
        close();
      }
    }
    document.addEventListener("keydown", keydown);
    onCleanup(() => document.removeEventListener("keydown", keydown));
  });

  function schedulePaint() {
    if (paintFrame !== undefined || nativeHighlights || !search.open()) return;
    paintFrame = requestAnimationFrame(() => {
      paintFrame = undefined;
      setRectangles(
        threadMatchRectangles(
          search.matches(),
          search.current(),
          props.viewport,
        ),
      );
    });
  }
  createEffect(() => {
    const matches = search.matches();
    const current = search.current();
    if (!search.open()) {
      setRectangles([]);
      return;
    }
    if (nativeHighlights) {
      const all = new Highlight();
      for (const match of matches) all.add(match.range);
      const active = new Highlight(
        ...(matches[current] ? [matches[current].range] : []),
      );
      active.priority = 1;
      CSS.highlights.set("thread-find-all", all);
      CSS.highlights.set("thread-find-current", active);
      onCleanup(() => {
        CSS.highlights.delete("thread-find-all");
        CSS.highlights.delete("thread-find-current");
      });
    } else schedulePaint();
  });
  createEffect(() => {
    if (nativeHighlights || !search.open()) return;
    createResizeObserver([props.viewport, props.content], schedulePaint);
    props.viewport.addEventListener("scroll", schedulePaint, true);
    window.addEventListener("resize", schedulePaint);
    onCleanup(() => {
      props.viewport.removeEventListener("scroll", schedulePaint, true);
      window.removeEventListener("resize", schedulePaint);
      if (paintFrame !== undefined) cancelAnimationFrame(paintFrame);
      paintFrame = undefined;
      setRectangles([]);
    });
  });
  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    if (paintFrame !== undefined) cancelAnimationFrame(paintFrame);
  });

  return (
    <>
      <div
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <For each={rectangles()}>
          {(rect) => (
            <span
              class={
                rect.current
                  ? "absolute bg-find-current/65"
                  : "absolute bg-find-match/50"
              }
              style={{
                left: `${rect.left}px`,
                top: `${rect.top}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
              }}
            />
          )}
        </For>
      </div>
      <Show when={search.open()}>
        <search
          ref={bar}
          aria-label={t("thread.find.label")}
          class="absolute top-3 right-6 flex max-w-[calc(100%-2.25rem)] items-center gap-1 rounded-lg border border-line bg-menu p-1.5 text-ink shadow-md"
        >
          <input
            ref={input}
            type="search"
            aria-label={t("thread.find.label")}
            placeholder={t("thread.find.placeholder")}
            class="h-7 w-40 min-w-0 flex-1 rounded bg-transparent px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-line"
            value={search.query()}
            onInput={(event) => {
              if (!composing) search.setQuery(event.currentTarget.value);
            }}
            onCompositionStart={() => {
              composing = true;
            }}
            onCompositionEnd={(event) => {
              composing = false;
              search.setQuery(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !composing && !event.isComposing) {
                event.preventDefault();
                search.move(event.shiftKey ? -1 : 1);
              }
            }}
          />
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            class="shrink-0 px-1 text-xs tabular-nums text-muted"
          >
            {search.matches().length ? search.current() + 1 : 0}/
            {search.matches().length}
          </span>
          <Button
            variant="ghost"
            size="icon"
            class="size-7 shrink-0"
            aria-label={t("thread.find.previous")}
            title={t("thread.find.previous")}
            disabled={!search.matches().length}
            onClick={() => search.move(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            class="-ml-1.5 size-7 shrink-0"
            aria-label={t("thread.find.next")}
            title={t("thread.find.next")}
            disabled={!search.matches().length}
            onClick={() => search.move(1)}
          >
            <ArrowDown />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            class="size-7 shrink-0"
            aria-label={t("thread.find.close")}
            title={t("thread.find.close")}
            onClick={close}
          >
            <X />
          </Button>
        </search>
      </Show>
    </>
  );
}
