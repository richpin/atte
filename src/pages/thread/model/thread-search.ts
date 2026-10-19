import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  findThreadMatches,
  revealThreadMatch,
  type ThreadSearchMatch,
} from "../lib/thread-search";

export function createThreadSearch(options: {
  content: () => HTMLElement;
  viewport: () => HTMLElement;
  bottomInset: () => number;
  topInset: () => number;
  onNavigate: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [matches, setMatches] = createSignal<ThreadSearchMatch[]>([]);
  const [current, setCurrent] = createSignal(0);
  let frame: number | undefined;
  let pendingNavigation = false;

  function navigate() {
    const match = matches()[current()];
    if (!match) return;
    options.onNavigate();
    revealThreadMatch(
      match,
      options.viewport(),
      options.bottomInset(),
      options.topInset(),
    );
  }

  function refresh() {
    frame = undefined;
    const oldIndex = current();
    const old = matches()[oldIndex];
    const next = findThreadMatches(options.content(), query());
    const same =
      old &&
      next.findIndex(
        (match) => match.block === old.block && match.start === old.start,
      );
    setMatches(next);
    setCurrent(
      pendingNavigation
        ? 0
        : same !== undefined && same >= 0
          ? same
          : Math.min(oldIndex, Math.max(0, next.length - 1)),
    );
    if (pendingNavigation) navigate();
    pendingNavigation = false;
  }

  function schedule() {
    if (frame === undefined) frame = requestAnimationFrame(refresh);
  }

  createEffect(() => {
    if (!open()) return;
    query();
    pendingNavigation = true;
    schedule();
  });

  createEffect(() => {
    if (!open()) return;
    const observer = new MutationObserver(schedule);
    observer.observe(options.content(), {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "hidden",
        "open",
        "class",
        "style",
        "data-thread-search-hidden",
      ],
    });
    onCleanup(() => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      pendingNavigation = false;
    });
  });

  function reset() {
    setOpen(false);
    setQuery("");
    setMatches([]);
    setCurrent(0);
  }

  function move(delta: number) {
    // Flush a pending DOM/query update before using its ranges.
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      refresh();
    }
    const count = matches().length;
    if (!count) return;
    setCurrent((value) => (value + delta + count) % count);
    navigate();
  }

  return {
    open,
    query,
    matches,
    current,
    setQuery,
    show: () => setOpen(true),
    close: () => {
      setOpen(false);
      setMatches([]);
      setCurrent(0);
    },
    reset,
    move,
  };
}
