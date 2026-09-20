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
    remoteSessionId: "session-1",
    authentication: "authenticated",
    failure: null,
    turns: [],
    notice: null,
    permissions: [],
    queuedMessages: [],
  };
}

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
        onDeleteQueued={async () => {}}
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
        onDeleteQueued={async () => {}}
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
    queuedMessages: [{ id: "queued", text: "next" }],
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
        onDeleteQueued={async () => {}}
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
