import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
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

it("shows a Pierre file icon before a sent file mention's basename", async () => {
  const sent = turn("Review @src/index.ts");
  sent.attachments = [
    {
      id: "resource",
      name: "index.ts",
      resource: {
        path: "src/index.ts",
        embedded: true,
        text: true,
        mentions: [
          { id: "m1", path: "src/index.ts", start: 7, end: 20, order: 0 },
        ],
      },
    },
  ];
  render(() => (
    <I18nProvider>
      <Message turns={[sent]} />
    </I18nProvider>
  ));
  const chip = screen
    .getByText("index.ts")
    .closest<HTMLElement>("[data-file-mention]");
  expect(chip?.title).toBe("src/index.ts");
  await waitFor(() =>
    expect(chip?.querySelector("svg use")?.getAttribute("href")).toContain(
      "file-tree-builtin-typescript",
    ),
  );
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

it("reveals the full clipped user message when conversation find navigates into it", () => {
  renderMessage("Long searchable message");
  const content = setMessageHeight("Long searchable message", 600);
  expect(
    screen
      .getByRole("button", { name: "Show more" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  content.dispatchEvent(new Event("thread-search-reveal"));
  expect(
    screen
      .getByRole("button", { name: "Show less" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(content.parentElement?.classList.contains("overflow-hidden")).toBe(
    false,
  );
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
  expect(screen.getByText("Response needed")).toBeTruthy();
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
        streamingTurnId={thinking()}
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
  fireEvent.click(screen.getByRole("button", { name: "Work log · 1 item" }));
  expect(
    screen
      .getByRole("button", { name: "Thinking" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(document.querySelector("[data-thought] l-tailspin")).toBeNull();
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
  expect(document.querySelector("[data-thought] l-tailspin")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Thinking" })).toHaveLength(1);
  expect(
    screen.getAllByRole("button", { name: "Work log · 1 item" }),
  ).toHaveLength(2);
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

it("folds a growing work log at a content boundary and preserves nested expansion across snapshots", () => {
  const [turns, setTurns] = createStore<Turn[]>([turn("Inspect")]);
  render(() => (
    <I18nProvider>
      <Message turns={turns} streamingTurnId="turn-1" thinkingTurnId="turn-1" />
    </I18nProvider>
  ));
  setTurns(0, "responseParts", [
    { kind: "thought", id: "thought", text: "Inspect carefully" },
  ]);
  const thought = screen.getByRole("button", { name: "Thinking" });
  fireEvent.click(thought);
  setTurns(0, "responseParts", 1, {
    kind: "tool",
    id: "read",
    tool: {
      title: "Read file",
      status: "in_progress",
      rawInput: "src/main.ts",
    },
  });
  const tool = screen.getByRole("button", { name: /Read file/ });
  fireEvent.click(tool);
  expect(screen.queryByRole("button", { name: /Work log/ })).toBeNull();
  expect(screen.getByText("Inspect carefully")).toBeTruthy();
  setTurns(0, "responseParts", 2, {
    kind: "text",
    id: "answer",
    text: "Answer",
  });
  const log = screen.getByRole("button", { name: "Work log · 2 items" });
  expect(log.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Thinking" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Read file/ })).toBeNull();
  fireEvent.click(log);
  expect(screen.getByRole("button", { name: "Thinking" })).toBe(thought);
  expect(screen.getByRole("button", { name: /Read file/ })).toBe(tool);
  expect(thought.getAttribute("aria-expanded")).toBe("true");
  expect(tool.getAttribute("aria-expanded")).toBe("true");
  setTurns(0, "responseParts", 1, (part) =>
    part.kind === "tool"
      ? { ...part, tool: { ...part.tool, status: "completed" as const } }
      : part,
  );
  // A replacement snapshot with the same IDs must retain both levels of state.
  setTurns(0, {
    ...turns[0],
    responseParts: JSON.parse(JSON.stringify(turns[0].responseParts)),
  });
  expect(screen.getByRole("button", { name: "Work log · 2 items" })).toBe(log);
  expect(log.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Thinking" })).toBe(thought);
  expect(screen.getByRole("button", { name: /Read file/ })).toBe(tool);
  expect(screen.getByText("src/main.ts")).toBeTruthy();
  expect(screen.getByText("Completed")).toBeTruthy();
  fireEvent.click(log);
  expect(log.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(log);
  expect(thought.getAttribute("aria-expanded")).toBe("true");
});

it("folds the final run on completion and uses the same label for failed and interrupted tools", () => {
  const [active, setActive] = createSignal<string | undefined>("turn-1");
  const current = turn("Run");
  current.responseParts = [
    {
      kind: "tool",
      id: "run",
      tool: { title: "Run command", status: "failed" },
    },
  ];
  render(() => (
    <I18nProvider>
      <Message turns={[current]} streamingTurnId={active()} interrupted />
    </I18nProvider>
  ));
  expect(screen.getByRole("button", { name: /Run command/ })).toBeTruthy();
  setActive(undefined);
  expect(
    screen
      .getByRole("button", { name: "Work log · 1 item" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(screen.queryByRole("button", { name: /Run command/ })).toBeNull();
});

it("keeps a closed run exposed while its tool needs input and folds it when the request resolves", () => {
  const [pending, setPending] = createSignal<string[]>([]);
  const current = turn("Inspect");
  current.responseParts = [
    {
      kind: "tool",
      id: "read",
      tool: { title: "Read file", status: "pending" },
    },
    { kind: "text", id: "text", text: "Waiting" },
  ];
  render(() => (
    <I18nProvider>
      <Message
        turns={[current]}
        streamingTurnId="turn-1"
        permissionToolIds={pending()}
      />
    </I18nProvider>
  ));
  const log = screen.getByRole("button", { name: "Work log · 1 item" });
  fireEvent.click(log);
  setPending(["read"]);
  expect(screen.queryByRole("button", { name: /Work log/ })).toBeNull();
  expect(screen.getByRole("button", { name: /Read file/ })).toBeTruthy();
  expect(screen.getByText("Response needed")).toBeTruthy();
  setPending([]);
  expect(
    screen
      .getByRole("button", { name: "Work log · 1 item" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(screen.queryByRole("button", { name: /Read file/ })).toBeNull();
});

it("starts historical runs collapsed and never merges work across turns", () => {
  const first = turn("First");
  first.responseParts = [{ kind: "thought", id: "first", text: "One" }];
  const second = { ...turn("Second"), id: "turn-2" };
  second.responseParts = [{ kind: "thought", id: "second", text: "Two" }];
  render(() => (
    <I18nProvider>
      <Message turns={[first, second]} />
    </I18nProvider>
  ));
  expect(
    screen.getAllByRole("button", { name: "Work log · 1 item" }),
  ).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Thinking" })).toBeNull();
});
