import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { I18nProvider } from "shared/i18n";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Turn } from "../model/types";
import { Message } from "./Message";

let resize!: () => void;
let animationFrames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  animationFrames = new Map();
  let nextAnimationFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrame++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames.delete(id);
  });
  localStorage.setItem("atte.locale", "en");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function turn(message: string): Turn {
  return {
    id: "turn-1",
    message,
    response: "",
    stopReason: null,
  };
}

function renderMessage(message: string) {
  render(() => (
    <I18nProvider>
      <Message turns={[turn(message)]} />
    </I18nProvider>
  ));
}

function setMessageHeight(message: string, height: number) {
  const text = screen.getByText(message);
  const content = text.closest<HTMLElement>("[data-user-message-content]");
  if (!content) throw new Error("Markdown body not found");
  content.style.lineHeight = "20px";
  Object.defineProperty(content, "scrollHeight", {
    configurable: true,
    value: height,
  });
  resize();
  return content;
}

it("renders user and agent message bodies through distinct Markdown variants", () => {
  const markdownTurn = turn("**User** prompt");
  markdownTurn.response = "**Agent** response";
  markdownTurn.stopReason = "end_turn";
  render(() => (
    <I18nProvider>
      <Message turns={[markdownTurn]} />
    </I18nProvider>
  ));

  const user = screen.getByText("User").closest("[data-markdown-body]");
  const agent = screen.getByText("Agent").closest("[data-markdown-body]");
  expect(user?.getAttribute("data-variant")).toBe("user");
  expect(agent?.getAttribute("data-variant")).toBe("agent");
  expect(
    user
      ?.closest("[data-message-participant]")
      ?.getAttribute("data-message-participant"),
  ).toBe("user");
  expect(
    agent
      ?.closest("[data-message-participant]")
      ?.getAttribute("data-message-participant"),
  ).toBe("agent");
});

it("updates only the actively streaming message body", () => {
  const [turns, setTurns] = createStore<Turn[]>([
    {
      id: "turn-1",
      message: "First prompt",
      response: "Completed response",
      stopReason: "end_turn",
    },
    {
      id: "turn-2",
      message: "Second prompt",
      response: "Streaming response",
      stopReason: null,
    },
  ]);
  const [streamingTurnId] = createSignal<string | undefined>("turn-2");
  const { container } = render(() => (
    <I18nProvider>
      <Message turns={turns} streamingTurnId={streamingTurnId()} />
    </I18nProvider>
  ));
  const completedBody = container.querySelectorAll<HTMLElement>(
    '[data-markdown-body][data-variant="agent"]',
  )[0];
  const completedParagraph = completedBody?.querySelector("p");

  setTurns(1, "response", "Streaming response grows");
  expect(animationFrames.size).toBe(1);
  for (const frame of animationFrames.values()) frame(performance.now());
  animationFrames.clear();

  expect(completedBody?.querySelector("p")).toBe(completedParagraph);
  expect(completedBody?.textContent).toContain("Completed response");
  expect(container.textContent).toContain("Streaming response grows");
});

it("does not offer expansion when the user message fits within 20 lines", () => {
  renderMessage("Short prompt");
  setMessageHeight("Short prompt", 400);

  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

it("expands and collapses a user message taller than 20 lines", () => {
  renderMessage("Long prompt");
  const content = setMessageHeight("Long prompt", 401);
  const clipping = content.parentElement;

  const showMore = screen.getByRole("button", { name: "Show more" });
  expect(showMore.getAttribute("aria-expanded")).toBe("false");
  expect(showMore.querySelector("svg")?.classList.contains("rotate-180")).toBe(
    false,
  );
  expect(clipping?.classList.contains("max-h-[25rem]")).toBe(true);
  expect(clipping?.classList.contains("overflow-hidden")).toBe(true);

  fireEvent.click(showMore);
  const showLess = screen.getByRole("button", { name: "Show less" });
  expect(showLess.getAttribute("aria-expanded")).toBe("true");
  expect(showLess.querySelector("svg")?.classList.contains("rotate-180")).toBe(
    true,
  );
  expect(clipping?.classList.contains("max-h-[25rem]")).toBe(false);
  expect(clipping?.classList.contains("overflow-hidden")).toBe(false);

  fireEvent.click(showLess);
  expect(
    screen
      .getByRole("button", { name: "Show more" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(clipping?.classList.contains("max-h-[25rem]")).toBe(true);
  expect(clipping?.classList.contains("overflow-hidden")).toBe(true);
});

it("updates folding when wrapping changes the rendered line count", () => {
  renderMessage("Responsive prompt");
  const content = setMessageHeight("Responsive prompt", 401);
  expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();

  Object.defineProperty(content, "scrollHeight", {
    configurable: true,
    value: 400,
  });
  resize();
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});
