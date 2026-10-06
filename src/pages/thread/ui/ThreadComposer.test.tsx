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
import type { ResponsePart, Thread } from "../model/types";
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
    workingFolder: "/workspace",
    agentId: "agent-1",
    status: "sessionReady",
    sessionId: "session-1",
    authentication: "authenticated",
    failure: null,
    completedTurnId: null,
    turns: [],
    notice: null,
    permissions: [],
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

it("switches from PromptInput to PermissionInput when approval is requested", () => {
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

  expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
  expect(
    screen.queryByRole("region", { name: "Permission request" }),
  ).toBeNull();

  setThread((current) => ({
    ...current,
    status: "waitingForApproval",
    permissions: [
      {
        id: "permission-1",
        toolCallId: "tool-1",
        title: "Run command?",
        details: "pnpm test",
        options: [{ id: "allow", name: "Allow" }],
      },
    ],
  }));

  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  expect(
    screen.getByRole("region", { name: "Permission request" }),
  ).toBeTruthy();
  expect(screen.getByText("pnpm test")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(onAnswer).toHaveBeenCalledWith("permission-1", "allow");
});

it.each(["light", "dark"])(
  "hides only displayed plan approval details in %s theme",
  (theme) => {
    localStorage.setItem("atte.theme", theme);
    const content = "# Greeting CLI\n- Add the command";
    const [thread, setThread] = createSignal<Thread>({
      ...readyThread(),
      status: "waitingForApproval",
      permissions: [
        {
          id: "permission-plan",
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
      permissions: [{ ...current.permissions[0], planReview: null }],
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

  fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), {
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
    status: "waitingForApproval" as const,
    turns: [
      { id: "turn", message: "hello", responseParts: [], stopReason: null },
    ],
    permissions: [
      {
        id: "permission",
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
    screen.getByRole("button", { name: "Stop current task" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: /Delete queued message/ }),
  ).toHaveProperty("disabled", true);
});
