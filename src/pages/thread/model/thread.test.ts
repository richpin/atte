import { QueryClient } from "@tanstack/solid-query";
import { invoke } from "@tauri-apps/api/core";
import { createComputed, createRoot, onCleanup } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createThreadModel } from "./thread";
import { collectTurnChanges } from "./turn-changes";
import type {
  ResponsePart,
  Thread,
  ThreadMetadata,
  ThreadUpdate,
} from "./types";

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
    contextUsage: null,
    status: "sessionReady",
    sessionId: id,
    authentication: "authenticated",
    failure: null,
    completedTurnId: null,
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
    turns: [
      { id: "turn", message: "hello", responseParts: [], stopReason: null },
    ],
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

function setup(notifyError?: (message: string) => void) {
  return createRoot((cleanup) => {
    dispose = cleanup;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.mount();
    onCleanup(() => queryClient.unmount());
    return createThreadModel(queryClient, notifyError);
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
      model
        .thread()
        ?.turns[0]?.responseParts.map((part) =>
          part.kind === "text" ? part.text : "",
        )
        .join("");
      responseRuns++;
    });
    return cleanup;
  });
  stream("A")({
    kind: "textDelta",
    partId: "text-1",
    threadId: "A",
    turnId: "turn",
    text: "Hello",
  });
  expect(
    model
      .thread()
      ?.turns[0]?.responseParts.map((part) =>
        part.kind === "text" ? part.text : "",
      )
      .join(""),
  ).toBe("Hello");
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
          responseParts: [],
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

it("starts a new thread without discarding the selected thread draft", async () => {
  const model = setup();
  await open(model, "A");
  model.setDraft("A draft");

  model.startNewThread();

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

it("selects advertised image media and keeps valid results beside picker errors", async () => {
  commands.set("select_media", async () => ({
    attachments: [
      {
        id: "image-1",
        name: "photo.png",
        kind: "image",
        mimeType: "image/png",
      },
    ],
    errors: [{ name: "not-an-image.txt" }],
  }));
  const model = setup();
  await open(
    model,
    "A",
    thread("A", { promptCapabilities: { image: true, audio: false } }),
  );

  await model.selectMedia("image");

  expect(invoke).toHaveBeenCalledWith("select_media", {
    id: "A",
    kind: "image",
    dialogTitle: "첨부할 이미지 선택",
  });
  expect(model.draftAttachments()[0]).toMatchObject({
    name: "photo.png",
    kind: "image",
  });
  expect(model.attachmentErrors()).toEqual(["not-an-image.txt"]);
});

it("snapshots exact clipboard image bytes only when image capability is advertised", async () => {
  commands.set("snapshot_clipboard_image", async () => ({
    attachments: [
      {
        id: "image-1",
        name: "clipboard.png",
        kind: "image",
        mimeType: "image/png",
      },
    ],
    errors: [],
  }));
  const model = setup();
  await open(
    model,
    "A",
    thread("A", { promptCapabilities: { image: true, audio: false } }),
  );
  const image = new File([new Uint8Array([1, 2, 3])], "clipboard.png", {
    type: "image/png",
  });
  Object.defineProperty(image, "arrayBuffer", {
    value: async () => new Uint8Array([1, 2, 3]).buffer,
  });

  await model.pasteImage(image);

  expect(invoke).toHaveBeenCalledWith("snapshot_clipboard_image", {
    id: "A",
    name: "clipboard.png",
    mimeType: "image/png",
    bytes: [1, 2, 3],
  });
  expect(model.draftAttachments()).toHaveLength(1);
});

it("rejects clipboard images locally when the agent lacks image capability", async () => {
  const model = setup();
  await open(model, "A");
  const image = new File(["image"], "clipboard.png", { type: "image/png" });

  await model.pasteImage(image);

  expect(model.error()).toBe("이 에이전트는 이미지 첨부를 지원하지 않습니다.");
  expect(invoke).not.toHaveBeenCalledWith(
    "snapshot_clipboard_image",
    expect.anything(),
  );
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

it("removes unsupported draft media after a capability update without losing text or linked files", async () => {
  commands.set("release_files", async () => undefined);
  commands.set("select_media", async ({ kind }) => ({
    attachments: [{ id: kind, name: `${kind}.png`, kind }],
    errors: [],
  }));
  commands.set("select_files", async () => ({
    attachments: [
      { id: "file", name: "notes.txt", uri: "file:///tmp/notes.txt" },
    ],
    errors: [],
  }));
  const model = setup();
  const initial = thread("A", {
    promptCapabilities: { image: true, audio: true },
  });
  await open(model, "A", initial);
  model.setDraft("keep text");
  await model.selectMedia("image");
  await model.selectMedia("audio");
  await model.selectFiles();

  const { turns: _turns, ...patch } = initial;
  stream("A")({
    kind: "patch",
    thread: { ...patch, promptCapabilities: { image: false, audio: true } },
    turnUpdates: [],
  });

  expect(model.draft()).toBe("keep text");
  expect(model.draftAttachments().map(({ id }) => id)).toEqual([
    "audio",
    "file",
  ]);
  expect(invoke).toHaveBeenCalledWith("release_files", {
    attachments: ["image"],
  });
  expect(model.error()).toBeUndefined();
});

it("discards a media picker result when its capability disappeared during selection", async () => {
  const selection = deferred<{
    attachments: { id: string; name: string; kind: "image" }[];
    errors: { name: string }[];
  }>();
  commands.set("select_media", () => selection.promise);
  commands.set("release_files", async () => undefined);
  const model = setup();
  const initial = thread("A", {
    promptCapabilities: { image: true, audio: false },
  });
  await open(model, "A", initial);
  const picking = model.selectMedia("image");
  stream("A")({
    kind: "thread",
    thread: { ...initial, promptCapabilities: { image: false, audio: false } },
  });
  selection.resolve({
    attachments: [{ id: "late", name: "late.png", kind: "image" }],
    errors: [],
  });
  await picking;

  expect(model.draftAttachments()).toEqual([]);
  expect(invoke).toHaveBeenCalledWith("release_files", {
    attachments: ["late"],
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
  model.startNewThread();

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
    partId: "text-1",
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

it("sorts unprompted threads by creation time and lets new prompts move ahead", async () => {
  const model = setup();
  const entries = [
    thread("A", { createdAt: 3, lastPromptAt: null }),
    thread("B", { createdAt: 1, lastPromptAt: null, updatedAt: 999 }),
    thread("C", { createdAt: 1, lastPromptAt: 2500 }),
    thread("D", { createdAt: 1, lastPromptAt: 3000 }),
  ];
  receiveList(entries);
  await vi.waitFor(() =>
    expect(model.history().map((entry) => entry.id)).toEqual([
      "A",
      "D",
      "C",
      "B",
    ]),
  );
  receiveList(
    entries.map((entry) =>
      entry.id === "C" ? { ...entry, lastPromptAt: 4000 } : entry,
    ),
  );
  await vi.waitFor(() =>
    expect(model.history().map((entry) => entry.id)).toEqual([
      "C",
      "A",
      "D",
      "B",
    ]),
  );
});

it("keeps failed threads with recorded attempts idle on reentry", async () => {
  const model = setup();
  await open(model, "B");
  await open(
    model,
    "A",
    thread("A", {
      status: "failed",
      failure: "sessionRestorationFailed",
      lastPromptAt: 1,
    }),
  );
  expect(model.thread()?.turns).toEqual([]);
  expect(model.canSend()).toBe(false);
  expect(model.canReconnect()).toBe(true);
  expect(invoke).not.toHaveBeenCalledWith("connect_thread", { id: "A" });
});

it("connects an unprompted failed thread on entry without retrying live failures", async () => {
  const model = setup();
  const failed = thread("A", {
    status: "failed",
    failure: "sessionRestorationFailed",
    lastPromptAt: null,
  });
  await open(model, "A", failed);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("connect_thread", { id: "A" }),
  );
  stream("A")({ kind: "patch", thread: failed, turnUpdates: [], errors: [] });
  await Promise.resolve();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "connect_thread"),
  ).toHaveLength(1);
  commands.set("connect_thread", async () => {
    stream("A")({
      kind: "thread",
      thread: thread("A", { lastPromptAt: null }),
    });
  });
  await open(model, "B");
  await open(model, "A", failed);
  await vi.waitFor(() => expect(model.canSend()).toBe(true));
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

it("keeps persistent failures in thread state without toast notifications", async () => {
  const notify = vi.fn();
  const model = setup(notify);
  const failed = thread("A", { status: "failed", failure: "processExited" });
  await open(model, "A", failed);
  expect(notify).not.toHaveBeenCalled();
  const event: ThreadUpdate = {
    kind: "patch",
    thread: failed,
    turnUpdates: [],
    errors: [{ id: "error-1", failure: "processExited" }],
  };
  stream("A")(event);
  stream("A")(event);
  expect(notify).not.toHaveBeenCalled();
  await open(model, "B");
  await open(model, "A", failed);
  expect(notify).not.toHaveBeenCalled();
  stream("A")({
    ...event,
    errors: [{ id: "error-2", failure: "processExited" }],
  });
  expect(notify).not.toHaveBeenCalled();
});

it("reports repeated command failures as separate notifications", async () => {
  const notify = vi.fn();
  const model = setup(notify);
  await open(model, "A");
  commands.set("delete_queued_message", async () => {
    throw new Error("same failure");
  });
  await model.deleteQueued("queued");
  await model.deleteQueued("queued");
  expect(notify.mock.calls.map(([message]) => message)).toEqual([
    "same failure",
    "same failure",
  ]);
});

it("toasts each request failure event once without changing the thread failure", async () => {
  const notify = vi.fn();
  const model = setup(notify);
  await open(model, "A");
  const failed = thread("A");
  const event: ThreadUpdate = {
    kind: "patch",
    thread: failed,
    turnUpdates: [],
    errors: [
      {
        id: "request-1",
        message: "메시지 실행에 실패했습니다. 다시 시도해주세요.",
      },
    ],
  };
  stream("A")(event);
  stream("A")(event);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(model.thread()?.failure).toBeNull();
  await open(model, "B");
  await open(model, "A", failed);
  expect(notify).toHaveBeenCalledTimes(1);
  stream("A")({
    ...event,
    errors: [
      {
        id: "request-2",
        message: "메시지 실행에 실패했습니다. 다시 시도해주세요.",
      },
    ],
  });
  expect(notify).toHaveBeenCalledTimes(2);
});

it("toasts a rejected send command without adding a thread failure", async () => {
  const notify = vi.fn();
  const model = setup(notify);
  await open(model, "A");
  model.setDraft("retry me");
  commands.set("send_message", async () => {
    throw new Error("Send rejected");
  });
  await model.send();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(model.thread()?.failure).toBeNull();
  expect(model.draft()).toBe("retry me");
});

it("keeps storage errors in thread state without toast notifications", async () => {
  const notify = vi.fn();
  const model = setup(notify);
  const resumed = thread("A", {
    interrupted: true,
    notice:
      "기존 맥락을 재개했습니다. 이 에이전트는 이전 메시지 표시를 지원하지 않습니다.",
  });
  await open(model, "A", resumed);
  expect(notify).not.toHaveBeenCalled();
  const failed = { ...resumed, storageError: "storage failed" };
  stream("A")({ kind: "thread", thread: failed });
  expect(notify).not.toHaveBeenCalled();
  const event: ThreadUpdate = {
    kind: "patch",
    thread: failed,
    turnUpdates: [],
    errors: [{ id: "storage-1", message: "storage failed" }],
  };
  stream("A")(event);
  stream("A")(event);
  expect(model.thread()?.storageError).toBe("storage failed");
  expect(notify).not.toHaveBeenCalled();
});

it("still reports error events that have no persistent thread error, once per occurrence", async () => {
  const notify = vi.fn();
  const model = setup(notify);
  await open(model, "A");
  const event: ThreadUpdate = {
    kind: "patch",
    thread: thread("A"),
    turnUpdates: [],
    errors: [{ id: "transient-1", message: "Operation rejected" }],
  };
  stream("A")(event);
  stream("A")(event);
  expect(notify).toHaveBeenCalledExactlyOnceWith("Operation rejected");
  stream("A")({
    ...event,
    errors: [{ id: "transient-2", message: "Operation rejected" }],
  });
  expect(notify).toHaveBeenCalledTimes(2);
});

it("shows subscription failure in state without toast notifications", async () => {
  const notify = vi.fn();
  const model = setup(notify);
  await open(model, "A", running("A"));
  stream("A")({
    kind: "textDelta",
    threadId: "A",
    turnId: "unknown",
    partId: "text-1",
    text: "ignored",
  });
  expect(model.subscriptionError()).toBe(true);
  expect(notify).not.toHaveBeenCalled();
});

it("does not toast a connection command rejection already represented by its failure patch", async () => {
  const notify = vi.fn();
  const model = setup(notify);
  await open(model, "A");
  commands.set("reconnect_thread", async () => {
    const failed = thread("A", { status: "failed", failure: "processExited" });
    stream("A")({
      kind: "patch",
      thread: failed,
      turnUpdates: [],
      errors: [{ id: "connection-1", failure: "processExited" }],
    });
    throw new Error("Connection failed");
  });
  await model.reconnect();
  expect(model.thread()?.failure).toBe("processExited");
  expect(notify).not.toHaveBeenCalled();
});

it("manually reconnects an idle thread and preserves its input", async () => {
  const model = setup();
  await open(model, "A");
  model.setDraft("keep this draft");
  expect(model.canReconnect()).toBe(true);
  await model.reconnect();
  expect(invoke).toHaveBeenCalledWith("reconnect_thread", { id: "A" });
  expect(model.draft()).toBe("keep this draft");
  stream("A")({ kind: "thread", thread: running("A") });
  expect(model.canReconnect()).toBe(false);
});

it("recovers subscription before connecting a failed agent", async () => {
  vi.useFakeTimers();
  const notify = vi.fn();
  const model = setup(notify);
  await open(model, "A");
  commands.set("subscribe_thread", async () => {
    throw new Error("subscription failure");
  });
  stream("A")({
    kind: "textDelta",
    partId: "text-1",
    threadId: "A",
    turnId: "unknown",
    text: "invalid",
  });
  for (let index = 0; index < 5; index++)
    await vi.advanceTimersByTimeAsync(5_000);
  expect(notify).not.toHaveBeenCalled();
  expect(model.subscriptionError()).toBe(true);
  expect(model.canReconnect()).toBe(true);
  commands.delete("subscribe_thread");
  await model.reconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(model.canReconnect()).toBe(false);
  stream("A")({
    kind: "thread",
    thread: thread("A", { status: "failed", failure: "processExited" }),
  });
  expect(invoke).toHaveBeenCalledWith("connect_thread", { id: "A" });
});

it("preserves text and tool order while updating only the matching call", async () => {
  const model = setup();
  await open(model, "A", running("A"));
  const receive = stream("A");
  receive({
    kind: "textDelta",
    threadId: "A",
    turnId: "turn",
    partId: "before",
    text: "Before",
  });
  receive({
    kind: "toolUpdate",
    threadId: "A",
    turnId: "turn",
    part: {
      kind: "tool",
      id: "tool-a",
      tool: { title: "Read", status: "in_progress" },
    },
  });
  receive({
    kind: "toolUpdate",
    threadId: "A",
    turnId: "turn",
    part: {
      kind: "tool",
      id: "tool-b",
      tool: { title: "Test", status: "in_progress" },
    },
  });
  receive({
    kind: "textDelta",
    threadId: "A",
    turnId: "turn",
    partId: "after",
    text: "After",
  });
  const initialText = model.thread()?.turns[0].responseParts[0];
  const initialTool = model.thread()?.turns[0].responseParts[1];
  receive({
    kind: "toolUpdate",
    threadId: "A",
    turnId: "turn",
    part: {
      kind: "tool",
      id: "tool-b",
      tool: { title: "Test", status: "failed", rawOutput: "Failure" },
    },
  });
  receive({
    kind: "toolUpdate",
    threadId: "A",
    turnId: "turn",
    part: {
      kind: "tool",
      id: "tool-a",
      tool: { title: "Read", status: "completed" },
    },
  });
  const parts = model.thread()?.turns[0].responseParts;
  expect(parts?.map((part) => part.id)).toEqual([
    "before",
    "tool-a",
    "tool-b",
    "after",
  ]);
  expect(parts?.[0]).toBe(initialText);
  expect(parts?.[1]).toBe(initialTool);
  expect(parts?.[2]).toEqual({
    kind: "tool",
    id: "tool-b",
    tool: { title: "Test", status: "failed", rawOutput: "Failure" },
  });
});

it("preserves reported file versions in snapshots and repeated tool updates", async () => {
  const model = setup();
  const part: Extract<ResponsePart, { kind: "tool" }> = {
    kind: "tool",
    id: "edit-file",
    tool: {
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/project/a.ts",
          oldText: "before",
          newText: "after",
        },
      ],
    },
  };
  await open(
    model,
    "A",
    thread("A", {
      turns: [
        {
          id: "turn",
          message: "",
          stopReason: null,
          responseParts: [structuredClone(part)],
        },
      ],
    }),
  );
  const receive = stream("A");
  const update: ThreadUpdate = {
    kind: "toolUpdate",
    threadId: "A",
    turnId: "turn",
    part,
  };
  receive(structuredClone(update));
  receive(structuredClone(update));
  const current = model.thread()?.turns[0];
  if (!current) throw new Error("missing turn");
  expect(current.responseParts).toHaveLength(1);
  expect(collectTurnChanges(current)).toEqual([
    {
      path: "/project/a.ts",
      comparisons: [{ before: "before", after: "after" }],
    },
  ]);
});

it("replaces plan snapshots in place without altering surrounding response parts", async () => {
  const model = setup();
  await open(model, "A", running("A"));
  const receive = stream("A");
  receive({
    kind: "textDelta",
    threadId: "A",
    turnId: "turn",
    partId: "before",
    text: "Before",
  });
  receive({
    kind: "planUpdate",
    threadId: "A",
    turnId: "turn",
    part: {
      kind: "plan",
      id: "plan",
      plan: {
        entries: [{ content: "Old", priority: "high", status: "pending" }],
      },
    },
  });
  receive({
    kind: "textDelta",
    threadId: "A",
    turnId: "turn",
    partId: "after",
    text: "After",
  });
  const first = model.thread()?.turns[0].responseParts[0];
  for (const entries of [
    [],
    [
      {
        content: "New",
        priority: "low" as const,
        status: "completed" as const,
      },
    ],
  ]) {
    receive({
      kind: "planUpdate",
      threadId: "A",
      turnId: "turn",
      part: { kind: "plan", id: "plan", plan: { entries } },
    });
  }
  const parts = model.thread()?.turns[0].responseParts;
  expect(parts?.map((part) => part.id)).toEqual(["before", "plan", "after"]);
  expect(parts?.[0]).toBe(first);
  expect(parts?.[1]).toMatchObject({
    plan: { entries: [{ content: "New", status: "completed" }] },
  });
});

it("appends thought deltas without invalidating the answer or neighboring activity", async () => {
  const model = setup();
  await open(model, "A", running("A"));
  const receive = stream("A");
  receive({
    kind: "textDelta",
    threadId: "A",
    turnId: "turn",
    partId: "answer",
    text: "Answer",
  });
  receive({
    kind: "toolUpdate",
    threadId: "A",
    turnId: "turn",
    part: {
      kind: "tool",
      id: "tool",
      tool: { title: "Read", status: "completed" },
    },
  });
  receive({
    kind: "thoughtDelta",
    threadId: "A",
    turnId: "turn",
    partId: "thought",
    text: "Think",
  });
  const parts = model.thread()?.turns[0].responseParts;
  const answer = parts?.[0];
  const tool = parts?.[1];
  let answerRuns = 0;
  let thoughtRuns = 0;
  const stop = createRoot((dispose) => {
    createComputed(() => {
      const part = model.thread()?.turns[0].responseParts[0];
      if (part?.kind === "text") part.text;
      answerRuns++;
    });
    createComputed(() => {
      const part = model.thread()?.turns[0].responseParts[2];
      if (part?.kind === "thought") part.text;
      thoughtRuns++;
    });
    return dispose;
  });
  receive({
    kind: "thoughtDelta",
    threadId: "A",
    turnId: "turn",
    partId: "thought",
    text: " more",
  });
  expect(parts?.[2]).toEqual({
    kind: "thought",
    id: "thought",
    text: "Think more",
  });
  expect(parts?.[0]).toBe(answer);
  expect(parts?.[1]).toBe(tool);
  expect(answerRuns).toBe(1);
  expect(thoughtRuns).toBe(2);
  stop();
});

it("keeps context usage scoped to selected snapshots and patches", async () => {
  const model = setup();
  const first = thread("A", { contextUsage: { used: 32_000, size: 100_000 } });
  await open(model, "A", first);
  expect(model.thread()?.contextUsage?.used).toBe(32_000);
  const { turns: _turns, ...patch } = first;
  stream("A")({
    kind: "patch",
    thread: { ...patch, contextUsage: { used: 12_000, size: 100_000 } },
    turnUpdates: [],
  });
  expect(model.thread()?.contextUsage?.used).toBe(12_000);
  await open(model, "B");
  stream("A")({ kind: "patch", thread: patch, turnUpdates: [] });
  expect(model.thread()?.contextUsage).toBeNull();
  await open(model, "A", {
    ...first,
    contextUsage: { used: 12_000, size: 100_000 },
  });
  expect(model.thread()?.contextUsage?.used).toBe(12_000);
  stream("A")({
    kind: "patch",
    thread: { ...patch, contextUsage: null, status: "connecting" },
    turnUpdates: [],
  });
  expect(model.thread()?.contextUsage).toBeNull();
});

it("updates and removes plans in earlier turns without disturbing neighboring responses", async () => {
  const model = setup();
  const initial = running("A");
  initial.turns[0].responseParts = [
    { kind: "text", id: "before", text: "Before" },
    {
      kind: "planContent",
      id: "doc",
      planId: "p",
      content: { type: "markdown", content: "# Initial" },
    },
    { kind: "text", id: "after", text: "After" },
  ];
  initial.turns.push({
    id: "next",
    message: "Next",
    responseParts: [],
    stopReason: null,
  });
  await open(model, "A", initial);
  const receive = stream("A");
  for (const content of [
    null,
    { type: "markdown" as const, content: "# Updated" },
  ]) {
    receive({
      kind: "planContentUpdate",
      threadId: "A",
      turnId: "turn",
      part: { kind: "planContent", id: "doc", planId: "p", content },
    });
  }
  expect(model.thread()?.turns[0].responseParts).toEqual([
    { kind: "text", id: "before", text: "Before" },
    {
      kind: "planContent",
      id: "doc",
      planId: "p",
      content: { type: "markdown", content: "# Updated" },
    },
    { kind: "text", id: "after", text: "After" },
  ]);
  expect(model.thread()?.turns[1].responseParts).toEqual([]);
});
