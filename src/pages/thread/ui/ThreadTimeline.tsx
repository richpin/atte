import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { ArrowDown } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onMount,
  Show,
} from "solid-js";
import { ThreadSearch } from "./ThreadSearch";

export function ThreadTimeline(props: {
  followKey: string;
  bottomInset?: number;
  active?: boolean;
  threadId?: string;
  findRequest?: number;
  overlay?: JSX.Element;
  children: JSX.Element;
}) {
  const { t } = useI18n();
  let viewport!: HTMLElement;
  let content!: HTMLDivElement;
  let following = true;
  let searchDetached = false;
  let awaitingUpwardScroll = false;
  let previousScrollTop = 0;
  const [awayFromBottom, setAwayFromBottom] = createSignal(false);
  const [findOpen, setFindOpen] = createSignal(false);
  const followKey = createMemo(() => props.followKey);
  const bottomInset = () => `${props.bottomInset ?? 64}px`;
  const atBottom = () =>
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;

  function followLatest() {
    searchDetached = false;
    following = true;
    viewport.scrollTop = viewport.scrollHeight;
    previousScrollTop = Math.max(0, viewport.scrollTop);
    setAwayFromBottom(false);
  }

  createEffect(on(() => props.threadId, followLatest));
  createEffect(
    on(followKey, () => {
      if (!searchDetached) followLatest();
    }),
  );
  onMount(() => {
    // Observe both streamed content and space changes caused by the composer.
    const { observe } = makeResizeObserver(() => {
      // Native scrolling can precede its scroll event (for example, dragging
      // the scrollbar). Do not overwrite an upward move in that interval.
      if (Math.max(0, viewport.scrollTop) < previousScrollTop && !atBottom()) {
        following = false;
        awaitingUpwardScroll = false;
      }
      if (
        !searchDetached &&
        (following || (atBottom() && !awaitingUpwardScroll))
      )
        followLatest();
      else setAwayFromBottom(!atBottom());
    });
    observe(content);
    observe(viewport);
  });

  return (
    <div class="relative h-full min-h-0 w-full">
      <section
        ref={viewport}
        aria-label={t("thread.timeline")}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable history needs keyboard access.
        tabIndex={0}
        class="absolute inset-0 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent [overflow-anchor:none]"
        style={{
          "scroll-padding-bottom": bottomInset(),
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) {
            following = false;
            awaitingUpwardScroll = true;
          }
        }}
        onKeyDown={(event) => {
          if (event.target !== viewport) return;
          if (
            ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
            (event.key === " " && event.shiftKey)
          ) {
            following = false;
            awaitingUpwardScroll = true;
          }
        }}
        onScroll={() => {
          const top = Math.max(0, viewport.scrollTop);
          if (top < previousScrollTop) {
            following = false;
            awaitingUpwardScroll = false;
          }
          // A queued event from our own scroll must not override upward intent.
          else if (!searchDetached && top > previousScrollTop && atBottom()) {
            following = true;
            awaitingUpwardScroll = false;
          }
          previousScrollTop = top;
          setAwayFromBottom(!atBottom());
        }}
      >
        <div
          ref={content}
          class="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 pt-6"
          style={{ "padding-bottom": bottomInset() }}
        >
          {props.children}
        </div>
      </section>
      <Show when={!findOpen()}>{props.overlay}</Show>
      <Show when={awayFromBottom()}>
        <button
          type="button"
          aria-label={t("thread.jumpToLatest")}
          title={t("thread.jumpToLatest")}
          class="absolute left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-canvas text-ink shadow-sm hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          style={{ bottom: bottomInset() }}
          onClick={followLatest}
        >
          <ArrowDown aria-hidden="true" class="size-[18px]" />
        </button>
      </Show>
      <ThreadSearch
        active={props.active ?? false}
        scopeKey={props.threadId}
        openRequest={props.findRequest}
        content={content}
        viewport={viewport}
        bottomInset={props.bottomInset ?? 64}
        onOpenChange={setFindOpen}
        onNavigate={() => {
          following = false;
          searchDetached = true;
          awaitingUpwardScroll = false;
        }}
      />
    </div>
  );
}
