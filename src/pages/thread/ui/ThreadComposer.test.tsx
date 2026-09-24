import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { I18nProvider } from "shared/i18n";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Thread } from "../model/types";
import { ThreadComposer } from "./ThreadComposer";

beforeEach(() => {
  localStorage.setItem("atte.locale", "en");
});

afterEach(cleanup);

function readyThread(): Thread {
  return {
    id: "thread-1",
    title: "Thread",
    createdAt: 1,
    updatedAt: 1,
    lastPromptAt: 1,
    interrupted: false,
    storageError: null,
    workingFolder: "/workspace",
    agentId: "agent-1",
    status: "sessionReady",
    sessionId: "session-1",
    authentication: "authenticated",
    failure: null,
    turns: [],
    notice: null,
    permissions: [],
    queuedMessages: [],
    configuration: [],
  };
}

it("renders agent-provided thread configuration and sends typed selections", () => {
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
        agentName="Agent"
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

  fireEvent.change(screen.getByRole("combobox", { name: "Model: Model A" }), {
    target: { value: "model-b" },
  });
  expect(onConfigure).toHaveBeenCalledWith("opaque-model", {
    type: "select",
    value: "model-b",
  });

  fireEvent.click(screen.getByText("Thread settings"));
  expect(screen.getByRole("group", { name: "Safe modes" })).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "Thinking: On" }));
  expect(onConfigure).toHaveBeenCalledWith("opaque-thinking", {
    type: "boolean",
    value: false,
  });
  expect(screen.getByText("Limit file access")).toBeTruthy();
});

it("switches from PromptInput to PermissionInput when approval is requested", () => {
  const [thread, setThread] = createSignal(readyThread());
  const onAnswer = vi.fn();

  render(() => (
    <I18nProvider>
      <ThreadComposer
        active={false}
        thread={thread()}
        agentName="Agent"
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
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(onAnswer).toHaveBeenCalledWith("permission-1", "allow");
});

it("submits PromptInput with Enter", () => {
  const onSend = vi.fn();

  render(() => (
    <I18nProvider>
      <ThreadComposer
        active={false}
        thread={readyThread()}
        agentName="Agent"
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

it("disables every thread mutation while the subscription is unavailable", () => {
  const current = {
    ...readyThread(),
    status: "waitingForApproval" as const,
    turns: [{ id: "turn", message: "hello", response: "", stopReason: null }],
    permissions: [
      {
        id: "permission",
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
        agentName="Agent"
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
