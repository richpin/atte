import {
  createEffect,
  createSignal,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

export function ConversationHistory(props: {
  followKey: string;
  children: JSX.Element;
}) {
  let viewport!: HTMLElement;
  let content!: HTMLDivElement;
  let following = true;
  let previousScrollTop = 0;
  const [awayFromBottom, setAwayFromBottom] = createSignal(false);
  const atBottom = () =>
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;

  function followLatest() {
    following = true;
    viewport.scrollTop = viewport.scrollHeight;
    previousScrollTop = Math.max(0, viewport.scrollTop);
    setAwayFromBottom(false);
  }

  createEffect(on(() => props.followKey, followLatest));
  onMount(() => {
    // Observe both streamed content and space changes caused by the composer.
    const observer = new ResizeObserver(() => {
      // Native scrolling can precede its scroll event (for example, dragging
      // the scrollbar). Do not overwrite an upward move in that interval.
      if (Math.max(0, viewport.scrollTop) < previousScrollTop && !atBottom())
        following = false;
      if (following) followLatest();
      else setAwayFromBottom(!atBottom());
    });
    observer.observe(content);
    observer.observe(viewport);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="relative min-h-0 w-full flex-1">
      <section
        ref={viewport}
        aria-label="대화 기록"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable history needs keyboard access.
        tabIndex={0}
        class="h-full overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent [overflow-anchor:none]"
        onWheel={(event) => {
          if (event.deltaY < 0) following = false;
        }}
        onKeyDown={(event) => {
          if (event.target !== viewport) return;
          if (
            ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
            (event.key === " " && event.shiftKey)
          )
            following = false;
        }}
        onScroll={() => {
          const top = Math.max(0, viewport.scrollTop);
          if (top < previousScrollTop) following = false;
          // A queued event from our own scroll must not override upward intent.
          else if (top > previousScrollTop && atBottom()) following = true;
          previousScrollTop = top;
          setAwayFromBottom(!atBottom());
        }}
      >
        <div ref={content} class="flex flex-col gap-4 px-6 pt-6 pb-16">
          {props.children}
        </div>
      </section>
      <Show when={awayFromBottom()}>
        <button
          type="button"
          aria-label="최신 내용으로 이동"
          title="최신 내용으로 이동"
          class="absolute bottom-3 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-canvas text-ink shadow-sm hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          onClick={followLatest}
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 5v14m-6-6 6 6 6-6" />
          </svg>
        </button>
      </Show>
    </div>
  );
}
