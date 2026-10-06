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
    responseParts: [],
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
  markdownTurn.responseParts = [
    { kind: "text", id: "text-1", text: "**Agent** response" },
  ];
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

it("renders sent resource links as non-clickable basename chips", () => {
  const attached = turn("");
  attached.attachments = [
    { id: "one", name: "diagram.png", uri: "file:///secret/diagram.png" },
  ];
  render(() => (
    <I18nProvider>
      <Message turns={[attached]} />
    </I18nProvider>
  ));

  expect(screen.getByText("diagram.png")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByText(/secret/)).toBeNull();
});

it("renders sent media as basename-only read-only typed chips", () => {
  const attached = turn("");
  attached.attachments = [
    {
      id: "image",
      name: "diagram.png",
      kind: "image",
      mimeType: "image/png",
    },
    {
      id: "audio",
      name: "voice.wav",
      kind: "audio",
      mimeType: "audio/wav",
    },
  ];
  render(() => (
    <I18nProvider>
      <Message turns={[attached]} />
    </I18nProvider>
  ));

  expect(screen.getByText("Image")).toBeTruthy();
  expect(screen.getByText("diagram.png")).toBeTruthy();
  expect(screen.getByText("Audio")).toBeTruthy();
  expect(screen.getByText("voice.wav")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByRole("audio")).toBeNull();
});

it("updates only the actively streaming message body", () => {
  const [turns, setTurns] = createStore<Turn[]>([
    {
      id: "turn-1",
      message: "First prompt",
      responseParts: [
        { kind: "text", id: "text-1", text: "Completed response" },
      ],
      stopReason: "end_turn",
    },
    {
      id: "turn-2",
      message: "Second prompt",
      responseParts: [
        { kind: "text", id: "text-1", text: "Streaming response" },
      ],
      stopReason: null,
    },
  ]);
  const [streamingTurnId, setStreamingTurnId] = createSignal<
    string | undefined
  >("turn-2");
  const { container } = render(() => (
    <I18nProvider>
      <Message
        turns={turns}
        streamingTurnId={streamingTurnId()}
        respondingTurnId={streamingTurnId()}
      />
    </I18nProvider>
  ));
  const completedBody = container.querySelectorAll<HTMLElement>(
    '[data-markdown-body][data-variant="agent"]',
  )[0];
  const completedParagraph = completedBody?.querySelector("p");
  const indicator = screen.getByRole("status", { name: "Responding…" });
  expect(indicator.previousElementSibling?.textContent).toContain(
    "Streaming response",
  );

  setTurns(1, "responseParts", 0, (part) => ({
    ...part,
    text: "Streaming response grows",
  }));
  expect(animationFrames.size).toBe(1);
  for (const frame of animationFrames.values()) frame(performance.now());
  animationFrames.clear();

  expect(completedBody?.querySelector("p")).toBe(completedParagraph);
  expect(completedBody?.textContent).toContain("Completed response");
  expect(container.textContent).toContain("Streaming response grows");
  expect(screen.getByRole("status", { name: "Responding…" })).toBe(indicator);

  setStreamingTurnId(undefined);
  expect(screen.queryByRole("status")).toBeNull();
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

it("renders tools between text parts and keeps the response indicator after them", () => {
  const current: Turn = {
    ...turn("Inspect"),
    responseParts: [
      { kind: "text", id: "before", text: "Before tool" },
      {
        kind: "tool",
        id: "call",
        tool: { title: "Read file", status: "in_progress" },
      },
      { kind: "text", id: "after", text: "After tool" },
    ],
  };
  const { container } = render(() => (
    <I18nProvider>
      <Message
        turns={[current]}
        streamingTurnId={current.id}
        respondingTurnId={current.id}
        permissionToolIds={["call"]}
      />
    </I18nProvider>
  ));
  const text = container.textContent ?? "";
  expect(text.indexOf("Before tool")).toBeLessThan(text.indexOf("Read file"));
  expect(text.indexOf("Read file")).toBeLessThan(text.indexOf("After tool"));
  expect(screen.getByText("Approval required")).toBeTruthy();
  const indicator = screen.getByRole("status", { name: "Responding…" });
  expect(indicator.previousElementSibling?.textContent).toContain("After tool");
});

it("keeps plan expansion and the response indicator when snapshots change", () => {
  const current = turn("Plan please");
  const [turns, setTurns] = createStore<Turn[]>([
    {
      ...current,
      responseParts: [{ kind: "plan", id: "plan", plan: { entries: [] } }],
    },
  ]);
  render(() => (
    <I18nProvider>
      <Message
        turns={turns}
        respondingTurnId={current.id}
        streamingTurnId={current.id}
      />
    </I18nProvider>
  ));
  const indicator = screen.getByRole("status", { name: "Responding…" });
  setTurns(0, "responseParts", 0, {
    kind: "plan",
    id: "plan",
    plan: {
      entries: [{ content: "Initial", priority: "high", status: "pending" }],
    },
  });
  expect(screen.getByRole("status", { name: "Responding…" })).toBe(indicator);
  fireEvent.click(screen.getByRole("button"));
  setTurns(0, "responseParts", 0, {
    kind: "plan",
    id: "plan",
    plan: {
      entries: [{ content: "Updated", priority: "low", status: "in_progress" }],
    },
  });
  expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(screen.getByRole("button").textContent).toContain("Updated");
  expect(screen.getByRole("status", { name: "Responding…" })).toBe(indicator);
});

it("keeps the response indicator with thoughts and stops thinking at the next response part", () => {
  const [turns, setTurns] = createStore<Turn[]>([turn("Inspect")]);
  const [thinking, setThinking] = createSignal<string | undefined>("turn-1");
  render(() => (
    <I18nProvider>
      <Message
        turns={turns}
        respondingTurnId="turn-1"
        thinkingTurnId={thinking()}
      />
    </I18nProvider>
  ));
  const indicator = screen.getByRole("status", { name: "Responding…" });
  setTurns(0, "responseParts", [
    { kind: "thought", id: "thought", text: "**Reasoning**" },
  ]);
  expect(screen.getByRole("status", { name: "Responding…" })).toBe(indicator);
  expect(screen.getByRole("button", { name: "Thinking" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Thinking" }));
  setTurns(0, "responseParts", 1, {
    kind: "text",
    id: "answer",
    text: "Answer",
  });
  expect(
    screen
      .getByRole("button", { name: "Thinking" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(document.querySelector("[data-thought] .animate-spin")).toBeNull();
  setTurns(0, "responseParts", 2, {
    kind: "thought",
    id: "next",
    text: "Review",
  });
  expect(
    screen
      .getAllByRole("button", { name: "Thinking" })[1]
      .getAttribute("aria-expanded"),
  ).toBe("false");
  setThinking(undefined);
  expect(document.querySelector("[data-thought] .animate-spin")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Thinking" })).toHaveLength(2);
});

it("renders plan documents in a persistent card without reclassifying ordinary text", () => {
  const [turns, setTurns] = createStore<Turn[]>([
    {
      ...turn("Plan please"),
      responseParts: [
        { kind: "text", id: "before", text: "Ordinary plan explanation" },
        {
          kind: "planContent",
          id: "doc",
          planId: "p",
          content: {
            type: "markdown",
            content: "# Proposed changes\n\n**Inspect** the code",
          },
        },
        { kind: "text", id: "after", text: "After the plan" },
      ],
    },
  ]);
  const { container } = render(() => (
    <I18nProvider>
      <Message turns={turns} />
    </I18nProvider>
  ));
  const card = container.querySelector("[data-plan-content]");
  expect(card?.querySelector("h3")?.textContent).toBe("Proposed changes");
  expect(card?.querySelector("strong")?.textContent).toBe("Inspect");
  expect(container.querySelectorAll("[data-plan-content]")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Plan" }));
  setTurns(0, "responseParts", 1, {
    kind: "planContent",
    id: "doc",
    planId: "p",
    content: null,
  });
  expect(container.querySelector("[data-plan-content]")).toBeNull();
  setTurns(0, "responseParts", 1, {
    kind: "planContent",
    id: "doc",
    planId: "p",
    content: { type: "markdown", content: "# Updated" },
  });
  expect(
    screen.getByRole("button", { name: "Plan" }).getAttribute("aria-expanded"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Plan" }));
  expect(screen.getByRole("heading", { name: "Updated" })).toBeTruthy();
  expect(
    [
      ...container.querySelectorAll(
        "[data-message-participant=agent], [data-plan-content]",
      ),
    ].map((part) => part.textContent?.trim()),
  ).toEqual(["Ordinary plan explanation", "PlanUpdated", "After the plan"]);
});

it("shows item plans and file references without loading or linking files", () => {
  const current = turn("Plan");
  current.responseParts = [
    {
      kind: "planContent",
      id: "items",
      planId: "items",
      content: {
        type: "items",
        entries: [
          { content: "Inspect", priority: "high", status: "completed" },
        ],
      },
    },
    {
      kind: "planContent",
      id: "file",
      planId: "file",
      content: { type: "file", uri: "file:///tmp/plan.md" },
    },
    {
      kind: "planContent",
      id: "empty",
      planId: "empty",
      content: { type: "markdown", content: "  " },
    },
  ];
  const { container } = render(() => (
    <I18nProvider>
      <Message turns={[current]} />
    </I18nProvider>
  ));
  expect(container.querySelectorAll("[data-plan-content]")).toHaveLength(2);
  expect(screen.getByText("1/1 completed")).toBeTruthy();
  expect(screen.getByText("file:///tmp/plan.md").tagName).toBe("P");
  expect(container.querySelector("a")).toBeNull();
});
