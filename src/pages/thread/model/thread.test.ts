import { invoke } from "@tauri-apps/api/core";
import { createRoot } from "solid-js";
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
  let reject!: (reason: Error) => void;
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
    interrupted: false,
    storageError: null,
    status: "sessionReady",
    remoteSessionId: id,
    authentication: "authenticated",
    failure: null,
    revision: 1,
    turns: [],
    notice: null,
    permissions: [],
    queuedMessages: [],
    ...changes,
  };
}

let dispose: () => void;
let streams: Map<string, ((update: ThreadUpdate) => void)[]>;
let list: (entries: ThreadMetadata[]) => void;
const commands = new Map<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
>();

function stream(id: string, index = 0) {
  const receive = streams.get(id)?.[index];
  if (!receive) throw new Error(`Missing subscription for ${id}`);
  return receive;
}

function setup() {
  return createRoot((cleanup) => {
    dispose = cleanup;
    return createThreadModel();
  });
}

beforeEach(() => {
  streams = new Map();
  commands.clear();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const values = args as Record<string, unknown>;
    const handler = commands.get(command);
    if (handler) return handler(values);
    if (command === "list_threads") return [];
    if (command === "get_thread") return thread(values.id as string);
    if (command === "subscribe_thread_list") {
      list = (values.channel as { onmessage: typeof list }).onmessage;
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

afterEach(() => dispose?.());

it("clears an old thread's error when a pending selection opens", async () => {
  const pending = deferred<Thread>();
  const send = deferred<Thread>();
  const model = setup();
  await model.openThread("A");
  commands.set("send_message", () => send.promise);
  model.setMessage("hello");
  const sending = model.send();
  commands.set("get_thread", () => pending.promise);
  const opening = model.openThread("B");
  send.reject(new Error("A failed"));
  await sending;
  pending.resolve(thread("B"));
  await opening;
  expect(model.thread()?.id).toBe("B");
  expect(model.error()).toBeUndefined();
});

it.each(["success", "failure"])(
  "ignores an older selection's late %s",
  async (outcome) => {
    const pending = deferred<Thread>();
    commands.set("get_thread", ({ id }) =>
      id === "A" ? pending.promise : Promise.resolve(thread("B")),
    );
    const model = setup();
    const opening = model.openThread("A");
    await model.openThread("B");
    if (outcome === "success") pending.resolve(thread("A"));
    else pending.reject(new Error("old selection"));
    await opening;
    expect(model.thread()?.id).toBe("B");
    expect(model.error()).toBeUndefined();
  },
);

it("keeps the displayed thread when it is selected again during another lookup", async () => {
  const model = setup();
  await model.openThread("A");
  const pending = deferred<Thread>();
  commands.set("get_thread", () => pending.promise);
  const opening = model.openThread("B");
  await model.openThread("A");
  pending.resolve(thread("B"));
  await opening;
  expect(model.thread()?.id).toBe("A");
});

it("rejects older snapshots and snapshots for another thread", async () => {
  const model = setup();
  await model.openThread("A");
  const receive = stream("A");
  receive({
    kind: "thread",
    thread: thread("A", { revision: 5, title: "new" }),
  });
  receive({
    kind: "thread",
    thread: thread("A", { revision: 4, title: "old" }),
  });
  receive({
    kind: "thread",
    thread: thread("B", { revision: 6 }),
  });
  expect(model.thread()?.title).toBe("new");
  expect(model.history()?.[0]?.title).toBe("new");
});

const running = (id: string) =>
  thread(id, {
    status: "running",
    turns: [{ id: "turn", message: "hello", response: "", stopReason: null }],
  });

it("appends duplicate text only once and ignores another thread's text", async () => {
  commands.set("get_thread", async () => running("A"));
  const model = setup();
  await model.openThread("A");
  const receive = stream("A");
  const delta = {
    kind: "textDelta",
    threadId: "A",
    revision: 2,
    turnId: "turn",
    text: "Hello",
  } as const;
  receive(delta);
  receive(delta);
  receive({ ...delta, threadId: "B", revision: 3, text: "wrong" });
  receive({ ...delta, revision: 3, text: " world" });
  expect(model.thread()?.turns[0]?.response).toBe("Hello world");
  expect(model.streamError()).toBe(false);
});

it.each([
  { revision: 3, turnId: "turn" },
  { revision: 2, turnId: "other" },
])(
  "blocks sending after invalid text $revision/$turnId and recovers by resubscribing",
  async (invalid) => {
    commands.set("get_thread", async () => running("A"));
    const model = setup();
    await model.openThread("A");
    const old = stream("A");
    old({
      kind: "textDelta",
      threadId: "A",
      text: "wrong",
      ...invalid,
    });
    expect(model.thread()?.turns[0]?.response).toBe("");
    expect(model.streamError()).toBe(true);
    expect(model.canSend()).toBe(false);
    model.retrySubscription();
    await Promise.resolve();
    stream(
      "A",
      1,
    )({
      kind: "thread",
      thread: thread("A", { revision: 4, notice: "recovered" }),
    });
    old({
      kind: "thread",
      thread: thread("A", {
        revision: 9,
        notice: "obsolete channel",
      }),
    });
    expect(model.thread()?.notice).toBe("recovered");
    expect(model.canSend()).toBe(true);
    expect(invoke).toHaveBeenCalledWith("unsubscribe_thread", {
      subscription: "A-1",
    });
  },
);

it.each(["list", "selected"])(
  "keeps newer %s metadata after an older initial list resolves",
  async (source) => {
    const pending = deferred<ThreadMetadata[]>();
    commands.set("list_threads", () => pending.promise);
    const model = setup();
    await model.openThread("A");
    const latest = thread("A", { revision: 2, title: "new title" });
    if (source === "list") list([latest]);
    else stream("A")({ kind: "thread", thread: latest });
    pending.resolve([thread("A", { title: "old title" })]);
    await vi.waitFor(() => expect(model.history.loading).toBe(false));
    expect(model.history()?.[0]?.title).toBe("new title");
    expect(model.listError()).toBe(false);
  },
);

it("preserves subscription metadata after an older list request fails", async () => {
  const pending = deferred<ThreadMetadata[]>();
  commands.set("list_threads", () => pending.promise);
  const model = setup();
  list([thread("A", { title: "latest" })]);
  pending.reject(new Error("old list request"));
  await vi.waitFor(() => expect(model.history.loading).toBe(false));
  expect(model.history()?.[0]?.title).toBe("latest");
  expect(model.listError()).toBe(false);
});

type Model = ReturnType<typeof createThreadModel>;
const actions: [
  string,
  (model: Model) => Promise<void>,
  (model: Model) => unknown,
][] = [
  ["send_message", (model) => model.send(), (model) => model.sending()],
  ["connect_thread", (model) => model.connect(), (model) => model.connecting()],
  [
    "answer_permission",
    (model) => model.answer("request", "allow"),
    (model) => model.answering(),
  ],
  ["cancel_turn", (model) => model.cancel(), (model) => model.cancelling()],
  [
    "delete_queued_message",
    (model) => model.deleteQueued("queued"),
    () => undefined,
  ],
];

it.each(actions)(
  "isolates late %s completion from a new view of the same thread",
  async (command, action, busy) => {
    commands.set("get_thread", async ({ id }) => running(id as string));
    const first = deferred<Thread>();
    const second = deferred<Thread>();
    commands.set(command, () => first.promise);
    const model = setup();
    await model.openThread("A");
    model.setMessage("first draft");
    const old = action(model);
    await model.openThread("B");
    await model.openThread("A");
    model.setMessage("new draft");
    commands.set(command, () => second.promise);
    const current = action(model);
    const currentBusy = busy(model);
    first.resolve(thread("A", { revision: 99, notice: "obsolete" }));
    await old;
    expect(model.thread()?.notice).toBeNull();
    expect(model.message()).toBe("new draft");
    expect(busy(model)).toBe(currentBusy);
    second.resolve(running("A"));
    await current;
  },
);

it.each(actions)(
  "ignores late %s failure after switching threads",
  async (command, action) => {
    commands.set("get_thread", async ({ id }) => running(id as string));
    const pending = deferred<Thread>();
    commands.set(command, () => pending.promise);
    const model = setup();
    await model.openThread("A");
    model.setMessage("hello");
    const old = action(model);
    await model.openThread("B");
    model.setMessage("B draft");
    pending.reject(new Error("A failed"));
    await old;
    expect(model.thread()?.id).toBe("B");
    expect(model.error()).toBeUndefined();
    expect(model.connectionRejected()).toBe(false);
    expect(model.message()).toBe("B draft");
    expect(model.canSend()).toBe(true);
  },
);

it("unsubscribes late registrations after disposal and ignores their updates", async () => {
  const registration = deferred<string>();
  let receive!: (update: ThreadUpdate) => void;
  commands.set("subscribe_thread", ({ channel }) => {
    receive = (channel as { onmessage: typeof receive }).onmessage;
    return registration.promise;
  });
  const model = setup();
  await model.openThread("A");
  dispose();
  registration.resolve("late");
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("unsubscribe_thread", {
      subscription: "late",
    }),
  );
  receive({
    kind: "thread",
    thread: thread("A", { revision: 2, notice: "disposed" }),
  });
  list([thread("B")]);
  expect(model.thread()?.notice).toBeNull();
  expect(model.history()).toEqual([]);
  expect(invoke).toHaveBeenCalledWith("unsubscribe_thread", {
    subscription: "list",
  });
  expect(invoke).not.toHaveBeenCalledWith("cancel_turn", expect.anything());
});

it("keeps a new thread sendable when old subscription cleanup fails", async () => {
  const cleanup = deferred<void>();
  commands.set("unsubscribe_thread", () => cleanup.promise);
  const model = setup();
  await model.openThread("A");
  await model.openThread("B");
  cleanup.reject(new Error("closed channel"));
  await Promise.resolve();
  await Promise.resolve();
  expect(model.canSend()).toBe(true);
  expect(model.streamError()).toBe(false);
});

it("cleans up a late registration after switching threads", async () => {
  const registration = deferred<string>();
  let old!: (update: ThreadUpdate) => void;
  commands.set("subscribe_thread", ({ id, channel }) => {
    if (id === "A") {
      old = (channel as { onmessage: typeof old }).onmessage;
      return registration.promise;
    }
    return Promise.resolve("B");
  });
  const model = setup();
  await model.openThread("A");
  await model.openThread("B");
  registration.resolve("late-A");
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("unsubscribe_thread", {
      subscription: "late-A",
    }),
  );
  old({
    kind: "thread",
    thread: thread("A", { revision: 3 }),
  });
  expect(model.thread()?.id).toBe("B");
  expect(model.canSend()).toBe(true);
});

it("cleans up a late list subscription when its owner is disposed", async () => {
  const registration = deferred<string>();
  commands.set("subscribe_thread_list", () => registration.promise);
  setup();
  dispose();
  registration.resolve("late-list");
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("unsubscribe_thread", {
      subscription: "late-list",
    }),
  );
});

it("shows subscription failure and retries through the model interface", async () => {
  commands.set("subscribe_thread", async () => {
    throw new Error("registration failed");
  });
  const model = setup();
  await model.openThread("A");
  await vi.waitFor(() => expect(model.streamError()).toBe(true));
  expect(model.canSend()).toBe(false);
  commands.delete("subscribe_thread");
  model.retrySubscription();
  stream("A")({
    kind: "thread",
    thread: thread("A", { revision: 2 }),
  });
  expect(model.streamError()).toBe(false);
  expect(model.canSend()).toBe(true);
});

it.each(["select_working_folder", "create_thread"])(
  "keeps a newer selection when %s completes late",
  async (command) => {
    const pending = deferred<Thread>();
    commands.set(command, () => pending.promise);
    const model = setup();
    const creating =
      command === "select_working_folder"
        ? model.selectFolder("codex")
        : model.createInFolder("/project", "codex");
    await model.openThread("B");
    model.setMessage("B draft");
    pending.resolve(thread("A"));
    await creating;
    expect(model.thread()?.id).toBe("B");
    expect(model.message()).toBe("B draft");
    expect(model.history()?.some((entry) => entry.id === "A")).toBe(true);
  },
);

it.each(actions)(
  "ignores %s completion after the model owner is disposed",
  async (command, action) => {
    commands.set("get_thread", async () => running("A"));
    const pending = deferred<Thread>();
    commands.set(command, () => pending.promise);
    const model = setup();
    await model.openThread("A");
    model.setMessage("draft");
    const work = action(model);
    dispose();
    pending.resolve(thread("A", { revision: 2, notice: "late" }));
    await work;
    expect(model.thread()?.notice).toBeNull();
    expect(model.message()).toBe("draft");
  },
);
