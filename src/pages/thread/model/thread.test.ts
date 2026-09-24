import { QueryClient } from "@tanstack/solid-query";
import { invoke } from "@tauri-apps/api/core";
import { createComputed, createRoot, onCleanup } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createThreadModel } from "./thread";
import type { Thread, ThreadMetadata, ThreadUpdate } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = () => {};
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function thread(id: string, changes: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    workingFolder: "/project",
    agentId: "codex",
    createdAt: 1,
    updatedAt: 1,
    lastPromptAt: 1,
    interrupted: false,
    storageError: null,
    status: "sessionReady",
    sessionId: id,
    authentication: "authenticated",
    failure: null,
    turns: [],
    notice: null,
    permissions: [],
    queuedMessages: [],
    ...changes,
    configuration: changes.configuration ?? [],
  };
}

const running = (id: string) =>
  thread(id, {
    status: "running",
    turns: [{ id: "turn", message: "hello", response: "", stopReason: null }],
  });

let dispose: () => void;
let streams: Map<string, ((update: ThreadUpdate) => void)[]>;
let receiveList: (entries: ThreadMetadata[]) => void;
const commands = new Map<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
>();

function stream(id: string, index = (streams.get(id)?.length ?? 1) - 1) {
  const receive = streams.get(id)?.[index];
  if (!receive) throw new Error(`Missing subscription for ${id}`);
  return receive;
}

function setup() {
  return createRoot((cleanup) => {
    dispose = cleanup;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.mount();
    onCleanup(() => queryClient.unmount());
    return createThreadModel(queryClient);
  });
}

async function open(
  model: ReturnType<typeof createThreadModel>,
  id: string,
  snapshot: Thread = thread(id),
) {
  await model.openThread(id);
  stream(id)({ kind: "thread", thread: snapshot });
}

beforeEach(() => {
  streams = new Map();
  commands.clear();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const values = args as Record<string, unknown>;
    const handler = commands.get(command);
    if (handler) return handler(values);
    if (command === "list_threads") return [];
    if (command === "subscribe_thread_list") {
      receiveList = (values.channel as { onmessage: typeof receiveList })
        .onmessage;
      return "list";
    }
    if (command === "subscribe_thread") {
      const id = values.id as string;
      const receivers = streams.get(id) ?? [];
      receivers.push(
        (values.channel as { onmessage: (update: ThreadUpdate) => void })
          .onmessage,
      );
      streams.set(id, receivers);
      return `${id}-${receivers.length}`;
    }
    if (command === "unsubscribe_thread") return;
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => {
  dispose?.();
  vi.useRealTimers();
});

it("opens a thread from the subscription snapshot without fetching it", async () => {
  const model = setup();
  await model.openThread("A");
  stream("A")({ kind: "thread", thread: thread("A", { title: "From feed" }) });
  expect(model.thread()?.title).toBe("From feed");
});

it("accepts snapshots only for the selected thread", async () => {
  const model = setup();
  await open(model, "A", thread("A", { title: "First" }));
  stream("A")({ kind: "thread", thread: thread("B", { title: "Wrong" }) });
  stream("A")({ kind: "thread", thread: thread("A", { title: "Latest" }) });
  expect(model.thread()?.title).toBe("Latest");
});

it("ignores updates from a subscription after switching threads", async () => {
  const model = setup();
  await open(model, "A");
  const oldSubscription = stream("A");
  await open(model, "B");

  oldSubscription({
    kind: "thread",
    thread: thread("A", { title: "Obsolete" }),
  });

  expect(model.thread()?.id).toBe("B");
  expect(model.thread()?.title).toBe("B");
});

it("appends a text delta only to the streamed response dependency", async () => {
  const model = setup();
  await open(model, "A", running("A"));
  const initialThread = model.thread();
  const initialTurns = initialThread?.turns;
  const initialTurn = initialTurns?.[0];
  let statusRuns = 0;
  let responseRuns = 0;
  const stopTracking = createRoot((cleanup) => {
    createComputed(() => {
      model.thread()?.status;
      statusRuns++;
    });
    createComputed(() => {
      model.thread()?.turns[0]?.response;
      responseRuns++;
    });
    return cleanup;
  });
  stream("A")({
    kind: "textDelta",
    threadId: "A",
    turnId: "turn",
    text: "Hello",
  });
  expect(model.thread()?.turns[0]?.response).toBe("Hello");
  expect(model.thread()).toBe(initialThread);
  expect(model.thread()?.turns).toBe(initialTurns);
  expect(model.thread()?.turns[0]).toBe(initialTurn);
  expect(statusRuns).toBe(1);
  expect(responseRuns).toBe(2);
  stopTracking();
});

it("applies lightweight patches without replacing existing turns", async () => {
  const model = setup();
  await open(model, "A", running("A"));
  const initialTurns = model.thread()?.turns;
  const initialTurn = initialTurns?.[0];
  const { turns: _, ...patch } = thread("A", {
    status: "waitingForApproval",
    updatedAt: 2,
  });

  stream("A")({ kind: "patch", thread: patch, turnUpdates: [] });

  expect(model.thread()?.status).toBe("waitingForApproval");
  expect(model.thread()?.turns).toBe(initialTurns);
  expect(model.thread()?.turns[0]).toBe(initialTurn);
});

it("applies incremental turn additions and completions", async () => {
  const model = setup();
  await open(model, "A");
  const { turns: _, ...runningPatch } = thread("A", { status: "running" });
  stream("A")({
    kind: "patch",
    thread: runningPatch,
    turnUpdates: [
      {
        kind: "added",
        turn: {
          id: "turn-2",
          message: "hello",
          response: "",
          stopReason: null,
        },
      },
    ],
  });
  const addedTurn = model.thread()?.turns[0];
  const { turns: __, ...readyPatch } = thread("A", {
    status: "sessionReady",
  });

  stream("A")({
    kind: "patch",
    thread: readyPatch,
    turnUpdates: [
      { kind: "completed", turnId: "turn-2", stopReason: "end_turn" },
    ],
  });

  expect(model.thread()?.turns[0]).toBe(addedTurn);
  expect(model.thread()?.turns[0]?.stopReason).toBe("end_turn");
});

it("updates the displayed thread only from its subscription", async () => {
  commands.set("send_message", async () => thread("A", { notice: "command" }));
  const model = setup();
  await open(model, "A");
  model.setDraft("hello");
  await model.send();
  expect(model.thread()?.notice).toBeNull();
  expect(model.draft()).toBe("");
  stream("A")({
    kind: "thread",
    thread: thread("A", { notice: "subscription" }),
  });
  expect(model.thread()?.notice).toBe("subscription");
});

it("changes thread configuration through a command and displays only subscription state", async () => {
  commands.set("set_thread_configuration", async () =>
    thread("A", { notice: "command result" }),
  );
  const model = setup();
  const configuration = [
    {
      id: "opaque-model",
      name: "Model",
      description: null,
      category: "model",
      type: "select" as const,
      currentValue: "model-a",
      options: {
        type: "flat" as const,
        options: [{ value: "model-a", name: "Model A", description: null }],
      },
    },
  ];
  await open(model, "A", thread("A", { configuration }));

  await model.configure("opaque-model", {
    type: "select",
    value: "model-b",
  });

  expect(invoke).toHaveBeenCalledWith("set_thread_configuration", {
    id: "A",
    configId: "opaque-model",
    value: { type: "select", value: "model-b" },
  });
  expect(model.thread()?.configuration[0].currentValue).toBe("model-a");
  stream("A")({
    kind: "thread",
    thread: thread("A", {
      configuration: [{ ...configuration[0], currentValue: "model-b" }],
    }),
  });
  expect(model.thread()?.configuration[0].currentValue).toBe("model-b");
});

it("clears an earlier configuration error when a later selection succeeds", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  let attempts = 0;
  commands.set("set_thread_configuration", () =>
    attempts++ === 0 ? first.promise : second.promise,
  );
  const model = setup();
  await open(model, "A");

  const failed = model.configure("opaque-thinking", {
    type: "boolean",
    value: false,
  });
  first.reject(new Error("rejected"));
  await failed;
  expect(model.error()).toBe("rejected");
  const succeeded = model.configure("opaque-thinking", {
    type: "boolean",
    value: true,
  });
  expect(model.error()).toBe("rejected");
  second.resolve();
  await succeeded;
  expect(model.error()).toBeUndefined();
});

it("does not clear a newer configuration error when an older selection finishes", async () => {
  const older = deferred<void>();
  const newer = deferred<void>();
  let attempts = 0;
  commands.set("set_thread_configuration", () =>
    attempts++ === 0 ? older.promise : newer.promise,
  );
  const model = setup();
  await open(model, "A");

  const oldSelection = model.configure("opaque-thinking", {
    type: "boolean",
    value: false,
  });
  const newSelection = model.configure("opaque-thinking", {
    type: "boolean",
    value: true,
  });
  newer.reject(new Error("latest rejected"));
  await newSelection;
  expect(model.error()).toBe("latest rejected");
  older.resolve();
  await oldSelection;
  expect(model.error()).toBe("latest rejected");
});

it("keeps the draft when sending fails", async () => {
  commands.set("send_message", async () => {
    throw new Error("failed");
  });
  const model = setup();
  await open(model, "A");
  model.setDraft("keep me");
  await model.send();
  expect(model.draft()).toBe("keep me");
  expect(model.error()).toBeDefined();
});

it("retries a failed queued input through the command boundary", async () => {
  commands.set("retry_queued_message", async () => undefined);
  const model = setup();
  await open(model, "A", {
    ...thread("A"),
    queuedMessages: [
      {
        id: "failed",
        text: "retry me",
        attachments: [],
        status: "failed",
      },
    ],
  });

  await model.retryQueued("failed");

  expect(invoke).toHaveBeenCalledWith("retry_queued_message", {
    id: "A",
    message: "failed",
  });
});

it("preserves independent drafts when switching threads", async () => {
  const model = setup();
  await open(model, "A");
  model.setDraft("A draft");
  await open(model, "B");
  expect(model.draft()).toBe("");
  model.setDraft("B draft");

  await open(model, "A");
  expect(model.draft()).toBe("A draft");
  await open(model, "B");
  expect(model.draft()).toBe("B draft");
});

it("starts a new chat without discarding the selected thread draft", async () => {
  const model = setup();
  await open(model, "A");
  model.setDraft("A draft");

  model.startNewChat();

  expect(model.selectedThreadId()).toBeUndefined();
  expect(model.thread()).toBeUndefined();
  expect(model.draft()).toBe("");
  await open(model, "A");
  expect(model.draft()).toBe("A draft");
});

it("clears only the sent thread draft after switching threads", async () => {
  const pending = deferred<void>();
  commands.set("send_message", () => pending.promise);
  const model = setup();
  await open(model, "A");
  model.setDraft("send A");
  const sendRequest = model.send();
  await open(model, "B");
  model.setDraft("keep B");

  pending.resolve();
  await sendRequest;
  expect(model.draft()).toBe("keep B");
  await open(model, "A");
  expect(model.draft()).toBe("");
});

it("does not clear a thread draft edited while its send is pending", async () => {
  const pending = deferred<void>();
  commands.set("send_message", () => pending.promise);
  const model = setup();
  await open(model, "A");
  model.setDraft("send this");
  const sendRequest = model.send();
  await open(model, "B");
  await open(model, "A");
  model.setDraft("new draft");

  pending.resolve();
  await sendRequest;
  expect(model.draft()).toBe("new draft");
});

it("selects duplicate files in order and sends attachment-only input atomically", async () => {
  commands.set("select_files", async () => ({
    attachments: [
      { id: "attachment-1", name: "notes.png", uri: "file:///tmp/notes.png" },
      { id: "attachment-2", name: "notes.png", uri: "file:///tmp/notes.png" },
    ],
    errors: [{ name: "folder" }],
  }));
  commands.set("send_message", async () => undefined);
  const model = setup();
  await open(model, "A");

  await model.selectFiles();

  expect(model.draftAttachments().map(({ name }) => name)).toEqual([
    "notes.png",
    "notes.png",
  ]);
  expect(model.attachmentErrors()).toEqual(["folder"]);

  await model.send();

  expect(invoke).toHaveBeenCalledWith("send_message", {
    id: "A",
    input: {
      text: "",
      attachments: ["attachment-1", "attachment-2"],
    },
  });
  expect(model.draftAttachments()).toEqual([]);
});

it("keeps the complete draft when attachment input delivery fails", async () => {
  commands.set("select_files", async () => ({
    attachments: [
      { id: "attachment-1", name: "notes.txt", uri: "file:///tmp/notes.txt" },
    ],
    errors: [],
  }));
  commands.set("send_message", async () => {
    throw new Error("failed");
  });
  const model = setup();
  await open(model, "A");
  model.setDraft("Read this");
  await model.selectFiles();

  await model.send();

  expect(model.draft()).toBe("Read this");
  expect(model.draftAttachments()).toHaveLength(1);
});

it("releases a selected file when its draft chip is removed", async () => {
  commands.set("select_files", async () => ({
    attachments: [
      { id: "attachment-1", name: "notes.txt", uri: "file:///tmp/notes.txt" },
    ],
    errors: [],
  }));
  commands.set("release_files", async () => undefined);
  const model = setup();
  await open(model, "A");
  await model.selectFiles();

  model.removeAttachment("attachment-1");

  expect(invoke).toHaveBeenCalledWith("release_files", {
    attachments: ["attachment-1"],
  });
});

it("releases files selected after navigation made the picker result stale", async () => {
  const selection = deferred<{
    attachments: { id: string; name: string; uri: string }[];
    errors: { name: string }[];
  }>();
  commands.set("select_files", () => selection.promise);
  commands.set("release_files", async () => undefined);
  const model = setup();
  await open(model, "A");
  const selecting = model.selectFiles();
  model.startNewChat();

  selection.resolve({
    attachments: [
      { id: "attachment-1", name: "notes.txt", uri: "file:///tmp/notes.txt" },
    ],
    errors: [],
  });
  await selecting;

  expect(invoke).toHaveBeenCalledWith("release_files", {
    attachments: ["attachment-1"],
  });
});

it("removes the draft when its thread is deleted", async () => {
  commands.set("delete_thread", async () => undefined);
  const model = setup();
  await open(model, "A");
  model.setDraft("discard me");
  await open(model, "B");

  await model.removeThread("A");
  await open(model, "A");
  expect(model.draft()).toBe("");
});

it("preserves the snapshot and blocks every mutation while retrying", async () => {
  const model = setup();
  const configuration = [
    {
      id: "opaque-thinking",
      name: "Thinking",
      description: null,
      category: null,
      type: "boolean" as const,
      currentValue: true,
    },
  ];
  await open(model, "A", { ...running("A"), configuration });
  stream("A")({
    kind: "textDelta",
    threadId: "A",
    turnId: "wrong-turn",
    text: "ignored",
  });
  model.setDraft("draft");
  await Promise.all([
    model.send(),
    model.connect(),
    model.cancel(),
    model.answer("request", "allow"),
    model.deleteQueued("queued"),
    model.configure("opaque-thinking", { type: "boolean", value: false }),
  ]);
  expect(model.thread()?.id).toBe("A");
  expect(model.actionsEnabled()).toBe(false);
  expect(model.draft()).toBe("draft");
  for (const command of [
    "send_message",
    "connect_thread",
    "cancel_turn",
    "answer_permission",
    "delete_queued_message",
    "set_thread_configuration",
  ]) {
    expect(invoke).not.toHaveBeenCalledWith(command, expect.anything());
  }
});

it("retries a failed subscription five times at five-second intervals", async () => {
  vi.useFakeTimers();
  commands.set("subscribe_thread", async () => {
    throw new Error("registration failed");
  });
  const model = setup();
  await model.openThread("A");
  await Promise.resolve();
  for (let attempt = 0; attempt < 5; attempt++)
    await vi.advanceTimersByTimeAsync(5_000);
  const registrations = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "subscribe_thread");
  expect(registrations).toHaveLength(6);
  expect(model.retryExhausted()).toBe(true);
});

it("reconnects manually after automatic retries are exhausted", async () => {
  vi.useFakeTimers();
  commands.set("subscribe_thread", async () => {
    throw new Error("registration failed");
  });
  const model = setup();
  await model.openThread("A");
  await Promise.resolve();
  for (let attempt = 0; attempt < 5; attempt++)
    await vi.advanceTimersByTimeAsync(5_000);
  commands.delete("subscribe_thread");
  model.retrySubscription();
  stream("A")({ kind: "thread", thread: thread("A") });
  expect(model.retryExhausted()).toBe(false);
  expect(model.actionsEnabled()).toBe(true);
});

it("returns to the list when the selected thread no longer exists", async () => {
  commands.set("subscribe_thread", async () => {
    throw { code: "notFound", message: "gone" };
  });
  const model = setup();
  await model.openThread("A");
  await vi.waitFor(() => expect(model.error()).toBeDefined());
  expect(model.thread()).toBeUndefined();
  expect(model.subscriptionError()).toBe(false);
});

it("subscribes with the id returned by thread creation", async () => {
  commands.set("create_thread", async () => "new-thread");
  const model = setup();
  await model.createInFolder("/project", "codex");
  expect(model.thread()).toBeUndefined();
  stream("new-thread")({
    kind: "thread",
    thread: thread("new-thread", { title: "Created" }),
  });
  expect(model.thread()?.title).toBe("Created");
});

it("ignores a late command failure after another thread opens", async () => {
  const pending = deferred<void>();
  commands.set("send_message", () => pending.promise);
  const model = setup();
  await open(model, "A");
  model.setDraft("A draft");
  const sendRequest = model.send();
  await open(model, "B");
  model.setDraft("B draft");
  pending.reject(new Error("old failure"));
  await sendRequest;
  expect(model.thread()?.id).toBe("B");
  expect(model.draft()).toBe("B draft");
  expect(model.error()).toBeUndefined();
});

it("keeps subscription metadata newer than the initial list request", async () => {
  const pending = deferred<ThreadMetadata[]>();
  commands.set("list_threads", () => pending.promise);
  const model = setup();
  receiveList([thread("A", { title: "Latest", lastPromptAt: 20 })]);
  pending.resolve([thread("A", { title: "Old", lastPromptAt: 10 })]);
  await vi.waitFor(() => expect(model.history()[0]?.title).toBe("Latest"));
});

it("unsubscribes late registrations after disposal", async () => {
  const registration = deferred<string>();
  commands.set("subscribe_thread", () => registration.promise);
  const model = setup();
  await model.openThread("A");
  dispose();
  registration.resolve("late");
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("unsubscribe_thread", {
      subscription: "late",
    }),
  );
});
