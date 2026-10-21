import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "shared/i18n";
import { ThemeProvider } from "shared/theme";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formDefaults } from "../model/elicitation";
import type {
  ElicitationRequest,
  FormField,
  FormValues,
  PendingInteraction,
  ResponsePart,
  Thread,
} from "../model/types";
import { ThreadComposer } from "./ThreadComposer";

beforeEach(() => {
  localStorage.setItem("atte.locale", "en");
});

afterEach(() => {
  cleanup();
  localStorage.removeItem("atte.theme");
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("color-scheme");
});

function readyThread(): Thread {
  return {
    id: "thread-1",
    title: "Thread",
    createdAt: 1,
    updatedAt: 1,
    lastPromptAt: 1,
    interrupted: false,
    storageError: null,
    contextUsage: null,
    availableCommands: [],
    workingFolder: "/workspace",
    worktree: null,
    agentId: "agent-1",
    status: "sessionReady",
    sessionId: "session-1",
    authentication: "authenticated",
    failure: null,
    completedTurnId: null,
    turns: [],
    notice: null,
    pendingInteractions: [],
    queuedMessages: [],
    configuration: [],
  };
}

it("renders agent-provided thread configuration and sends typed selections", async () => {
  const onConfigure = vi.fn();
  const current = readyThread();
  current.configuration = [
    {
      id: "opaque-model",
      name: "Model",
      description: "Choose the model",
      category: "model",
      type: "select",
      currentValue: "model-a",
      options: {
        type: "flat",
        options: [
          { value: "model-a", name: "Model A", description: null },
          { value: "model-b", name: "Model B", description: "Faster" },
        ],
      },
    },
    {
      id: "opaque-sandbox",
      name: "Sandbox",
      description: "Limit file access",
      category: "future_category",
      type: "select",
      currentValue: "workspace",
      options: {
        type: "grouped",
        groups: [
          {
            id: "safe",
            name: "Safe modes",
            options: [
              { value: "workspace", name: "Workspace", description: null },
            ],
          },
        ],
      },
    },
    {
      id: "opaque-thinking",
      name: "Thinking",
      description: null,
      category: null,
      type: "boolean",
      currentValue: true,
    },
  ];

  render(() => (
    <I18nProvider>
      <ThreadComposer
        active={false}
        thread={current}
        draft=""
        answerPending={false}
        cancelPending={false}
        showStop={false}
        stopping={false}
        actionsEnabled={true}
        canSend={true}
        onDraftChange={() => {}}
        onSend={() => {}}
        onCancel={() => {}}
        onAnswer={() => {}}
        onConfigure={onConfigure}
        onDeleteQueued={async () => {}}
        onRetryQueued={async () => {}}
      />
    </I18nProvider>
  ));

  await userEvent.click(screen.getByRole("button", { name: "Model Model A" }));
  await userEvent.click(screen.getByRole("option", { name: "Model B" }));
  expect(onConfigure).toHaveBeenCalledWith("opaque-model", {
    type: "select",
    value: "model-b",
  });

  expect(screen.queryByText("Thread settings")).toBeNull();
  expect(screen.getByRole("button", { name: "Sandbox Workspace" }).title).toBe(
    "Limit file access",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Sandbox Workspace" }),
  );
  expect(screen.getByText("Safe modes")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("switch", { name: "Thinking: On" }));
  expect(onConfigure).toHaveBeenCalledWith("opaque-thinking", {
    type: "boolean",
    value: false,
  });
});

it("replaces the message input with the approval card", () => {
  const [thread, setThread] = createSignal(readyThread());
  const onAnswer = vi.fn();

  render(() => (
    <I18nProvider>
      <ThreadComposer
        active={false}
        thread={thread()}
        draft=""
        answerPending={false}
        cancelPending={false}
        showStop={false}
        stopping={false}
        actionsEnabled={true}
        canSend={true}
        onDraftChange={() => {}}
        onSend={() => {}}
        onCancel={() => {}}
        onAnswer={onAnswer}
        onConfigure={() => {}}
        onDeleteQueued={async () => {}}
        onRetryQueued={async () => {}}
      />
    </I18nProvider>
  ));

  expect(screen.getByRole("combobox", { name: "Message" })).toBeTruthy();
  expect(
    screen.queryByRole("region", { name: "Permission request" }),
  ).toBeNull();

  setThread((current) => ({
    ...current,
    status: "waitingForInput",
    pendingInteractions: [
      {
        id: "permission-1",
        kind: "permission" as const,
        toolCallId: "tool-1",
        title: "Run command?",
        details: "pnpm test",
        options: [{ id: "allow", name: "Allow" }],
      },
    ],
  }));

  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
  expect(
    screen.getByRole("region", { name: "Permission request" }),
  ).toBeTruthy();
  expect(screen.getByText("pnpm test")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(onAnswer).toHaveBeenCalledWith("permission-1", "allow");
});

it.each<FormField>([
  { type: "string", default: "sample" },
  { type: "integer", default: 2 },
  { type: "number", default: 0.5 },
  { type: "boolean", default: false },
  { type: "string", enum: ["safe", "fast"], default: "safe" },
  {
    type: "array",
    items: { enum: ["unit", "integration"] },
    default: ["unit"],
  },
])(
  "replaces the composer with $type questions and restores the draft and attachments",
  async (field) => {
    const question: ElicitationRequest = {
      kind: "elicitation",
      id: "question",
      message: "Choose the approach",
      toolCallId: null,
      schema: { properties: { answer: { ...field, title: "Answer" } } },
    };
    const onSend = vi.fn();
    const onAnswerQuestion = vi.fn();
    const [current, setCurrent] = createSignal<Thread>({
      ...readyThread(),
      status: "waitingForInput",
      pendingInteractions: [question],
    });
    render(() => (
      <I18nProvider>
        <ThreadComposer
          active={false}
          thread={current()}
          draft="keep this draft"
          draftAttachments={[
            {
              id: "file",
              kind: "file",
              name: "notes.txt",
              uri: "file:///workspace/notes.txt",
              mimeType: "text/plain",
            },
          ]}
          answerPending={false}
          cancelPending={false}
          showStop={true}
          stopping={false}
          actionsEnabled={true}
          canSend={true}
          onDraftChange={() => {}}
          onSend={onSend}
          onCancel={() => {}}
          onAnswer={() => {}}
          formValues={formDefaults}
          onAnswerQuestion={onAnswerQuestion}
          onConfigure={() => {}}
          onDeleteQueued={async () => {}}
          onRetryQueued={async () => {}}
        />
      </I18nProvider>
    ));
    expect(screen.getByRole("region", { name: "Agent question" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add attachment" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Stop current task" }),
    ).toBeNull();
    expect(document.querySelectorAll("form")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswerQuestion).toHaveBeenCalledExactlyOnceWith(
      question,
      "accept",
    );
    expect(onSend).not.toHaveBeenCalled();
    setCurrent(readyThread());
    const prompt = screen.getByRole("combobox", { name: "Message" });
    expect(prompt).toHaveProperty("value", "keep this draft");
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Agent question" })).toBeNull();
    prompt.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledOnce();
    expect(onAnswerQuestion).toHaveBeenCalledTimes(1);
  },
);

function requestNavigation() {
  const first: ElicitationRequest = {
    kind: "elicitation",
    id: "first",
    message: "First question",
    toolCallId: null,
    schema: {
      properties: { answer: { type: "string", title: "Answer" } },
      required: ["answer"],
    },
  };
  const second: ElicitationRequest = {
    ...first,
    id: "second",
    message: "Second question",
  };
  const permission: PendingInteraction = {
    kind: "permission",
    id: "permission",
    toolCallId: "tool",
    title: "Run checks?",
    details: "pnpm validate",
    options: [{ id: "allow", name: "Allow once" }],
  };
  const [current, setCurrent] = createSignal<Thread>({
    ...readyThread(),
    status: "waitingForInput",
    pendingInteractions: [first, second, permission],
  });
  const [drafts, setDrafts] = createSignal<Record<string, FormValues>>({});
  const [answerPending, setAnswerPending] = createSignal(false);
  const [actionsEnabled, setActionsEnabled] = createSignal(true);
  const onAnswerQuestion = vi.fn();
  const onAnswer = vi.fn();
  render(() => (
    <I18nProvider>
      <ThreadComposer
        active={true}
        thread={current()}
        draft="keep this draft"
        answerPending={answerPending()}
        cancelPending={false}
        showStop={true}
        stopping={false}
        actionsEnabled={actionsEnabled()}
        canSend={false}
        onDraftChange={() => {}}
        onSend={() => {}}
        onCancel={() => {}}
        onAnswer={onAnswer}
        formValues={(request) => drafts()[request.id] ?? {}}
        onFormChange={(request, name, value) =>
          setDrafts((previous) => ({
            ...previous,
            [request.id]: Object.fromEntries(
              Object.entries({ ...previous[request.id], [name]: value }).filter(
                ([, item]) => item !== undefined,
              ),
            ) as FormValues,
          }))
        }
        onAnswerQuestion={onAnswerQuestion}
        onConfigure={() => {}}
        onDeleteQueued={async () => {}}
        onRetryQueued={async () => {}}
      />
    </I18nProvider>
  ));
  return {
    first,
    second,
    permission,
    current,
    setCurrent,
    setAnswerPending,
    setActionsEnabled,
    onAnswerQuestion,
    onAnswer,
  };
}

it("navigates mixed requests, preserves question drafts and answers only the selected request", async () => {
  const view = requestNavigation();
  expect(screen.getByRole("status").textContent).toBe("1 / 3");
  expect(
    screen.getByRole("button", { name: "Previous request" }),
  ).toHaveProperty("disabled", true);
  const navigation = screen.getByRole("navigation", {
    name: "Pending requests",
  });
  const close = screen.getByRole("button", { name: "Dismiss question" });
  expect(
    navigation.compareDocumentPosition(close) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await userEvent.type(
    screen.getByRole("textbox", { name: "Answer *" }),
    "first draft",
  );
  screen.getByRole("button", { name: "Next request" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("status").textContent).toBe("2 / 3");
  expect(screen.getByText("Second question")).toBeTruthy();
  await userEvent.type(
    screen.getByRole("textbox", { name: "Answer *" }),
    "second draft",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Previous request" }),
  );
  expect(screen.getByRole("textbox", { name: "Answer *" })).toHaveProperty(
    "value",
    "first draft",
  );
  // An unanswered required field on another page must not block this page's response.
  await userEvent.clear(screen.getByRole("textbox", { name: "Answer *" }));
  await userEvent.click(screen.getByRole("button", { name: "Next request" }));
  expect(screen.getByRole("textbox", { name: "Answer *" })).toHaveProperty(
    "value",
    "second draft",
  );
  await userEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect(view.onAnswerQuestion).toHaveBeenCalledExactlyOnceWith(
    view.second,
    "accept",
  );
  await userEvent.click(screen.getByRole("button", { name: "Next request" }));
  expect(screen.getByRole("status").textContent).toBe("3 / 3");
  expect(screen.getByRole("button", { name: "Next request" })).toHaveProperty(
    "disabled",
    true,
  );
  await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
  expect(view.onAnswer).toHaveBeenCalledExactlyOnceWith("permission", "allow");
});

it("keeps the selected request through list updates and recovers when requests resolve or the thread changes", async () => {
  const view = requestNavigation();
  await userEvent.click(screen.getByRole("button", { name: "Next request" }));
  const extra = { ...view.first, id: "extra", message: "New question" };
  view.setCurrent((current) => ({
    ...current,
    pendingInteractions: [extra, view.first, view.second, view.permission],
  }));
  expect(screen.getByRole("status").textContent).toBe("3 / 4");
  expect(screen.getByText("Second question")).toBeTruthy();
  view.setCurrent((current) => ({
    ...current,
    pendingInteractions: [extra, view.second, view.permission],
  }));
  expect(screen.getByRole("status").textContent).toBe("2 / 3");
  view.setCurrent((current) => ({
    ...current,
    pendingInteractions: [extra, view.permission],
  }));
  expect(screen.getByRole("status").textContent).toBe("1 / 2");
  expect(screen.getByText("New question")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Next request" }));
  view.setCurrent((current) => ({
    ...current,
    id: "other-thread",
    pendingInteractions: [view.first, view.second, view.permission],
  }));
  expect(screen.getByRole("status").textContent).toBe("1 / 3");
  view.setCurrent((current) => ({
    ...current,
    pendingInteractions: [view.second],
  }));
  expect(screen.getByText("Second question")).toBeTruthy();
  expect(
    screen.queryByRole("navigation", { name: "Pending requests" }),
  ).toBeNull();
  view.setCurrent((current) => ({
    ...current,
    pendingInteractions: [],
    status: "sessionReady",
  }));
  expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty(
    "value",
    "keep this draft",
  );
});

it("blocks request navigation while responding or without a live subscription", async () => {
  const view = requestNavigation();
  await userEvent.click(screen.getByRole("button", { name: "Next request" }));
  view.setAnswerPending(true);
  expect(
    screen.getByRole("button", { name: "Previous request" }),
  ).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Next request" })).toHaveProperty(
    "disabled",
    true,
  );
  await userEvent.click(screen.getByRole("button", { name: "Next request" }));
  expect(screen.getByRole("status").textContent).toBe("2 / 3");
  view.setAnswerPending(false);
  view.setActionsEnabled(false);
  expect(
    screen.getByRole("button", { name: "Previous request" }),
  ).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Next request" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(view.onAnswerQuestion).not.toHaveBeenCalled();
  expect(view.onAnswer).not.toHaveBeenCalled();
});

it.each(["light", "dark"])(
  "hides only displayed plan approval details in %s theme",
  (theme) => {
    localStorage.setItem("atte.theme", theme);
    const content = "# Greeting CLI\n- Add the command";
    const [thread, setThread] = createSignal<Thread>({
      ...readyThread(),
      status: "waitingForInput",
      pendingInteractions: [
        {
          id: "permission-plan",
          kind: "permission" as const,
          toolCallId: "plan-review:document",
          title: "Implement this plan?",
          details: content,
          planReview: { planId: "document", content },
          options: [
            { id: "implement_plan", name: "Implement" },
            { id: "revise_plan", name: "Revise" },
          ],
        },
      ],
    });
    const onAnswer = vi.fn();
    render(() => (
      <ThemeProvider>
        <I18nProvider>
          <ThreadComposer
            active={false}
            thread={thread()}
            draft=""
            answerPending={false}
            cancelPending={false}
            showStop={false}
            stopping={false}
            actionsEnabled={true}
            canSend={true}
            onDraftChange={() => {}}
            onSend={() => {}}
            onCancel={() => {}}
            onAnswer={onAnswer}
            onConfigure={() => {}}
            onDeleteQueued={async () => {}}
            onRetryQueued={async () => {}}
          />
        </I18nProvider>
      </ThemeProvider>
    ));

    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(screen.getByText(/Greeting CLI/)).toBeTruthy();
    setThread((current) => ({
      ...current,
      turns: [
        {
          id: "turn",
          message: "Plan the CLI",
          stopReason: null,
          responseParts: [
            {
              kind: "planContent",
              id: "plan-part",
              planId: "document",
              content: { type: "markdown", content },
            },
          ],
        },
      ],
    }));
    expect(screen.queryByText(/Greeting CLI/)).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Implement this plan?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Implement" }));
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    expect(onAnswer.mock.calls).toEqual([
      ["permission-plan", "implement_plan"],
      ["permission-plan", "revise_plan"],
    ]);

    for (const part of [
      {
        kind: "planContent",
        id: "plan-part",
        planId: "other-document",
        content: { type: "markdown", content },
      },
      {
        kind: "planContent",
        id: "plan-part",
        planId: "document",
        content: { type: "markdown", content: "# Updated plan" },
      },
      {
        kind: "planContent",
        id: "plan-part",
        planId: "document",
        content: { type: "markdown", content: " " },
      },
      {
        kind: "planContent",
        id: "plan-part",
        planId: "document",
        content: null,
      },
      {
        kind: "planContent",
        id: "plan-part",
        planId: "document",
        content: { type: "file", uri: "file:///tmp/plan.md" },
      },
      { kind: "text", id: "message-part", text: content },
    ] satisfies ResponsePart[]) {
      setThread((current) => ({
        ...current,
        turns: [{ ...current.turns[0], responseParts: [part] }],
      }));
      expect(screen.getByText(/Greeting CLI/)).toBeTruthy();
    }

    setThread((current) => ({
      ...current,
      pendingInteractions: [
        { ...current.pendingInteractions[0], planReview: null },
      ],
      turns: [
        {
          ...current.turns[0],
          responseParts: [
            {
              kind: "planContent",
              id: "plan-part",
              planId: "document",
              content: { type: "markdown", content },
            },
          ],
        },
      ],
    }));
    expect(screen.getByText(/Greeting CLI/)).toBeTruthy();
  },
);

it("submits PromptInput with Enter", () => {
  const onSend = vi.fn();

  render(() => (
    <I18nProvider>
      <ThreadComposer
        active={false}
        thread={readyThread()}
        draft="Run tests"
        answerPending={false}
        cancelPending={false}
        showStop={false}
        stopping={false}
        actionsEnabled={true}
        canSend={true}
        onDraftChange={() => {}}
        onSend={onSend}
        onCancel={() => {}}
        onAnswer={() => {}}
        onConfigure={() => {}}
        onDeleteQueued={async () => {}}
        onRetryQueued={async () => {}}
      />
    </I18nProvider>
  ));

  fireEvent.keyDown(screen.getByRole("combobox", { name: "Message" }), {
    key: "Enter",
  });
  expect(onSend).toHaveBeenCalledOnce();
});

it("selects files and renders removable duplicate basename chips without paths", async () => {
  const onSelectFiles = vi.fn();
  const onRemoveAttachment = vi.fn();
  render(() => (
    <I18nProvider>
      <ThreadComposer
        active={false}
        thread={readyThread()}
        draft=""
        draftAttachments={[
          {
            id: "one",
            name: "notes.txt",
            uri: "file:///private/one/notes.txt",
          },
          {
            id: "two",
            name: "notes.txt",
            uri: "file:///private/two/notes.txt",
          },
        ]}
        attachmentErrors={["folder"]}
        answerPending={false}
        cancelPending={false}
        showStop={false}
        stopping={false}
        actionsEnabled={true}
        canSend={true}
        onDraftChange={() => {}}
        onSelectFiles={onSelectFiles}
        onRemoveAttachment={onRemoveAttachment}
        onSend={() => {}}
        onCancel={() => {}}
        onAnswer={() => {}}
        onConfigure={() => {}}
        onDeleteQueued={async () => {}}
        onRetryQueued={async () => {}}
      />
    </I18nProvider>
  ));

  await userEvent.click(screen.getByRole("button", { name: "Add attachment" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "File" }));
  expect(onSelectFiles).toHaveBeenCalledOnce();
  expect(screen.getAllByText("notes.txt")).toHaveLength(2);
  expect(screen.queryByText(/private/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();

  fireEvent.click(
    (
      await screen.findAllByRole("button", {
        name: "Remove attachment: notes.txt",
      })
    )[1],
  );
  expect(onRemoveAttachment).toHaveBeenCalledWith("two");
  expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
    "disabled",
    false,
  );
});

it("shows media choices only for advertised prompt capabilities", async () => {
  const onSelectMedia = vi.fn();
  const current = readyThread();
  current.promptCapabilities = { image: true, audio: false };
  const [thread, setThread] = createSignal(current);
  render(() => (
    <I18nProvider>
      <ThreadComposer
        active={false}
        thread={thread()}
        draft=""
        answerPending={false}
        cancelPending={false}
        showStop={false}
        stopping={false}
        actionsEnabled={true}
        canSend={true}
        onDraftChange={() => {}}
        onSelectMedia={onSelectMedia}
        onSend={() => {}}
        onCancel={() => {}}
        onAnswer={() => {}}
        onConfigure={() => {}}
        onDeleteQueued={async () => {}}
        onRetryQueued={async () => {}}
      />
    </I18nProvider>
  ));

  await userEvent.click(screen.getByRole("button", { name: "Add attachment" }));
  expect(screen.getByRole("menuitem", { name: "Image" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Audio" })).toBeNull();
  await userEvent.click(screen.getByRole("menuitem", { name: "Image" }));
  expect(onSelectMedia).toHaveBeenCalledWith("image");
  setThread({ ...current, promptCapabilities: { image: false, audio: false } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeTruthy(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Add attachment" }));
  expect(screen.queryByRole("menuitem", { name: "Image" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Audio" })).toBeNull();
  expect(screen.getByRole("menuitem", { name: "File" })).toBeTruthy();
});

it("disables every thread mutation while the subscription is unavailable", () => {
  const current = {
    ...readyThread(),
    status: "waitingForInput" as const,
    turns: [
      { id: "turn", message: "hello", responseParts: [], stopReason: null },
    ],
    pendingInteractions: [
      {
        id: "permission",
        kind: "permission" as const,
        toolCallId: "tool-1",
        title: "Run command?",
        details: "pnpm test",
        options: [{ id: "allow", name: "Allow" }],
      },
    ],
    queuedMessages: [
      {
        id: "queued",
        text: "next",
        attachments: [],
        status: "pending" as const,
      },
    ],
  };

  render(() => (
    <I18nProvider>
      <ThreadComposer
        active={false}
        thread={current}
        draft="draft"
        answerPending={false}
        cancelPending={false}
        showStop={true}
        stopping={false}
        actionsEnabled={false}
        canSend={false}
        onDraftChange={() => {}}
        onSend={() => {}}
        onCancel={() => {}}
        onAnswer={() => {}}
        onConfigure={() => {}}
        onDeleteQueued={async () => {}}
        onRetryQueued={async () => {}}
      />
    </I18nProvider>
  ));

  expect(screen.getByRole("button", { name: "Allow" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(
    screen.queryByRole("button", { name: "Stop current task" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: /Delete queued message/ }),
  ).toHaveProperty("disabled", true);
});

it("sizes the slash popup to the composer without an intrinsic minimum width", async () => {
  const rect = (x: number, y: number, width: number, height: number) => ({
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON() {},
  });
  const bounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "FORM") return rect(180, 480, 720, 140);
      if (this.tagName === "TEXTAREA") return rect(196, 496, 688, 60);
      return rect(0, 0, 1200, 900);
    });
  const current = readyThread();
  current.availableCommands = [
    {
      name: "review",
      description: "A long description ".repeat(60),
      inputHint: null,
    },
  ];
  const [draft, setDraft] = createSignal("");
  render(() => (
    <I18nProvider>
      <ThreadComposer
        active={false}
        thread={current}
        draft={draft()}
        answerPending={false}
        cancelPending={false}
        showStop={false}
        stopping={false}
        actionsEnabled={true}
        canSend={true}
        onDraftChange={setDraft}
        onSend={() => {}}
        onCancel={() => {}}
        onAnswer={() => {}}
        onConfigure={() => {}}
        onDeleteQueued={async () => {}}
        onRetryQueued={async () => {}}
      />
    </I18nProvider>
  ));
  try {
    await userEvent.type(
      screen.getByRole("combobox", { name: "Message" }),
      "/",
    );
    const popup = screen
      .getByRole("listbox")
      .closest("[data-popper-positioner]") as HTMLElement;
    await waitFor(() => expect(popup.style.width).toBe("720px"));
    expect(popup.style.minWidth).toBe("0px");
  } finally {
    bounds.mockRestore();
  }
});
