import { invoke } from "@tauri-apps/api/core";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createConversationModel } from "./conversation";
import type {
  Conversation,
  ConversationMetadata,
  ConversationUpdate,
} from "./types";

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

function conversation(
  id: string,
  changes: Partial<Conversation> = {},
): Conversation {
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
let streams: Map<string, ((update: ConversationUpdate) => void)[]>;
let list: (entries: ConversationMetadata[]) => void;
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
    return createConversationModel();
  });
}

beforeEach(() => {
  streams = new Map();
  commands.clear();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const values = args as Record<string, unknown>;
    const handler = commands.get(command);
    if (handler) return handler(values);
    if (command === "list_conversations") return [];
    if (command === "get_conversation")
      return conversation(values.id as string);
    if (command === "subscribe_conversation_list") {
      list = (values.channel as { onmessage: typeof list }).onmessage;
      return "list";
    }
    if (command === "subscribe_conversation") {
      const id = values.id as string;
      const receivers = streams.get(id) ?? [];
      receivers.push(
        (values.channel as { onmessage: (update: ConversationUpdate) => void })
          .onmessage,
      );
      streams.set(id, receivers);
      return `${id}-${receivers.length}`;
    }
    if (command === "unsubscribe_conversation") return;
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => dispose?.());

it("clears an old conversation's error when a pending selection opens", async () => {
  const pending = deferred<Conversation>();
  const send = deferred<Conversation>();
  const model = setup();
  await model.openConversation("A");
  commands.set("send_message", () => send.promise);
  model.setMessage("hello");
  const sending = model.send();
  commands.set("get_conversation", () => pending.promise);
  const opening = model.openConversation("B");
  send.reject(new Error("A failed"));
  await sending;
  pending.resolve(conversation("B"));
  await opening;
  expect(model.conversation()?.id).toBe("B");
  expect(model.error()).toBeUndefined();
});

it.each(["success", "failure"])(
  "ignores an older selection's late %s",
  async (outcome) => {
    const pending = deferred<Conversation>();
    commands.set("get_conversation", ({ id }) =>
      id === "A" ? pending.promise : Promise.resolve(conversation("B")),
    );
    const model = setup();
    const opening = model.openConversation("A");
    await model.openConversation("B");
    if (outcome === "success") pending.resolve(conversation("A"));
    else pending.reject(new Error("old selection"));
    await opening;
    expect(model.conversation()?.id).toBe("B");
    expect(model.error()).toBeUndefined();
  },
);

it("keeps the displayed conversation when it is selected again during another lookup", async () => {
  const model = setup();
  await model.openConversation("A");
  const pending = deferred<Conversation>();
  commands.set("get_conversation", () => pending.promise);
  const opening = model.openConversation("B");
  await model.openConversation("A");
  pending.resolve(conversation("B"));
  await opening;
  expect(model.conversation()?.id).toBe("A");
});

it("rejects older snapshots and snapshots for another conversation", async () => {
  const model = setup();
  await model.openConversation("A");
  const receive = stream("A");
  receive({
    kind: "conversation",
    conversation: conversation("A", { revision: 5, title: "new" }),
  });
  receive({
    kind: "conversation",
    conversation: conversation("A", { revision: 4, title: "old" }),
  });
  receive({
    kind: "conversation",
    conversation: conversation("B", { revision: 6 }),
  });
  expect(model.conversation()?.title).toBe("new");
  expect(model.history()?.[0]?.title).toBe("new");
});

const running = (id: string) =>
  conversation(id, {
    status: "running",
    turns: [{ id: "turn", message: "hello", response: "", stopReason: null }],
  });

it("appends duplicate text only once and ignores another conversation's text", async () => {
  commands.set("get_conversation", async () => running("A"));
  const model = setup();
  await model.openConversation("A");
  const receive = stream("A");
  const delta = {
    kind: "textDelta",
    conversationId: "A",
    revision: 2,
    turnId: "turn",
    text: "Hello",
  } as const;
  receive(delta);
  receive(delta);
  receive({ ...delta, conversationId: "B", revision: 3, text: "wrong" });
  receive({ ...delta, revision: 3, text: " world" });
  expect(model.conversation()?.turns[0]?.response).toBe("Hello world");
  expect(model.streamError()).toBe(false);
});

it.each([
  { revision: 3, turnId: "turn" },
  { revision: 2, turnId: "other" },
])(
  "blocks sending after invalid text $revision/$turnId and recovers by resubscribing",
  async (invalid) => {
    commands.set("get_conversation", async () => running("A"));
    const model = setup();
    await model.openConversation("A");
    const old = stream("A");
    old({
      kind: "textDelta",
      conversationId: "A",
      text: "wrong",
      ...invalid,
    });
    expect(model.conversation()?.turns[0]?.response).toBe("");
    expect(model.streamError()).toBe(true);
    expect(model.canSend()).toBe(false);
    model.retrySubscription();
    await Promise.resolve();
    stream(
      "A",
      1,
    )({
      kind: "conversation",
      conversation: conversation("A", { revision: 4, notice: "recovered" }),
    });
    old({
      kind: "conversation",
      conversation: conversation("A", {
        revision: 9,
        notice: "obsolete channel",
      }),
    });
    expect(model.conversation()?.notice).toBe("recovered");
    expect(model.canSend()).toBe(true);
    expect(invoke).toHaveBeenCalledWith("unsubscribe_conversation", {
      subscription: "A-1",
    });
  },
);

it.each(["list", "selected"])(
  "keeps newer %s metadata after an older initial list resolves",
  async (source) => {
    const pending = deferred<ConversationMetadata[]>();
    commands.set("list_conversations", () => pending.promise);
    const model = setup();
    await model.openConversation("A");
    const latest = conversation("A", { revision: 2, title: "new title" });
    if (source === "list") list([latest]);
    else stream("A")({ kind: "conversation", conversation: latest });
    pending.resolve([conversation("A", { title: "old title" })]);
    await vi.waitFor(() => expect(model.history.loading).toBe(false));
    expect(model.history()?.[0]?.title).toBe("new title");
    expect(model.listError()).toBe(false);
  },
);

it("preserves subscription metadata after an older list request fails", async () => {
  const pending = deferred<ConversationMetadata[]>();
  commands.set("list_conversations", () => pending.promise);
  const model = setup();
  list([conversation("A", { title: "latest" })]);
  pending.reject(new Error("old list request"));
  await vi.waitFor(() => expect(model.history.loading).toBe(false));
  expect(model.history()?.[0]?.title).toBe("latest");
  expect(model.listError()).toBe(false);
});

type Model = ReturnType<typeof createConversationModel>;
const actions: [
  string,
  (model: Model) => Promise<void>,
  (model: Model) => unknown,
][] = [
  ["send_message", (model) => model.send(), (model) => model.sending()],
  [
    "connect_conversation",
    (model) => model.connect(),
    (model) => model.connecting(),
  ],
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
  "isolates late %s completion from a new view of the same conversation",
  async (command, action, busy) => {
    commands.set("get_conversation", async ({ id }) => running(id as string));
    const first = deferred<Conversation>();
    const second = deferred<Conversation>();
    commands.set(command, () => first.promise);
    const model = setup();
    await model.openConversation("A");
    model.setMessage("first draft");
    const old = action(model);
    await model.openConversation("B");
    await model.openConversation("A");
    model.setMessage("new draft");
    commands.set(command, () => second.promise);
    const current = action(model);
    const currentBusy = busy(model);
    first.resolve(conversation("A", { revision: 99, notice: "obsolete" }));
    await old;
    expect(model.conversation()?.notice).toBeNull();
    expect(model.message()).toBe("new draft");
    expect(busy(model)).toBe(currentBusy);
    second.resolve(running("A"));
    await current;
  },
);

it.each(actions)(
  "ignores late %s failure after switching conversations",
  async (command, action) => {
    commands.set("get_conversation", async ({ id }) => running(id as string));
    const pending = deferred<Conversation>();
    commands.set(command, () => pending.promise);
    const model = setup();
    await model.openConversation("A");
    model.setMessage("hello");
    const old = action(model);
    await model.openConversation("B");
    model.setMessage("B draft");
    pending.reject(new Error("A failed"));
    await old;
    expect(model.conversation()?.id).toBe("B");
    expect(model.error()).toBeUndefined();
    expect(model.connectionRejected()).toBe(false);
    expect(model.message()).toBe("B draft");
    expect(model.canSend()).toBe(true);
  },
);

it("unsubscribes late registrations after disposal and ignores their updates", async () => {
  const registration = deferred<string>();
  let receive!: (update: ConversationUpdate) => void;
  commands.set("subscribe_conversation", ({ channel }) => {
    receive = (channel as { onmessage: typeof receive }).onmessage;
    return registration.promise;
  });
  const model = setup();
  await model.openConversation("A");
  dispose();
  registration.resolve("late");
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("unsubscribe_conversation", {
      subscription: "late",
    }),
  );
  receive({
    kind: "conversation",
    conversation: conversation("A", { revision: 2, notice: "disposed" }),
  });
  list([conversation("B")]);
  expect(model.conversation()?.notice).toBeNull();
  expect(model.history()).toEqual([]);
  expect(invoke).toHaveBeenCalledWith("unsubscribe_conversation", {
    subscription: "list",
  });
  expect(invoke).not.toHaveBeenCalledWith("cancel_turn", expect.anything());
});

it("keeps a new conversation sendable when old subscription cleanup fails", async () => {
  const cleanup = deferred<void>();
  commands.set("unsubscribe_conversation", () => cleanup.promise);
  const model = setup();
  await model.openConversation("A");
  await model.openConversation("B");
  cleanup.reject(new Error("closed channel"));
  await Promise.resolve();
  await Promise.resolve();
  expect(model.canSend()).toBe(true);
  expect(model.streamError()).toBe(false);
});

it("cleans up a late registration after switching conversations", async () => {
  const registration = deferred<string>();
  let old!: (update: ConversationUpdate) => void;
  commands.set("subscribe_conversation", ({ id, channel }) => {
    if (id === "A") {
      old = (channel as { onmessage: typeof old }).onmessage;
      return registration.promise;
    }
    return Promise.resolve("B");
  });
  const model = setup();
  await model.openConversation("A");
  await model.openConversation("B");
  registration.resolve("late-A");
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("unsubscribe_conversation", {
      subscription: "late-A",
    }),
  );
  old({
    kind: "conversation",
    conversation: conversation("A", { revision: 3 }),
  });
  expect(model.conversation()?.id).toBe("B");
  expect(model.canSend()).toBe(true);
});

it("cleans up a late list subscription when its owner is disposed", async () => {
  const registration = deferred<string>();
  commands.set("subscribe_conversation_list", () => registration.promise);
  setup();
  dispose();
  registration.resolve("late-list");
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("unsubscribe_conversation", {
      subscription: "late-list",
    }),
  );
});

it("shows subscription failure and retries through the model interface", async () => {
  commands.set("subscribe_conversation", async () => {
    throw new Error("registration failed");
  });
  const model = setup();
  await model.openConversation("A");
  await vi.waitFor(() => expect(model.streamError()).toBe(true));
  expect(model.canSend()).toBe(false);
  commands.delete("subscribe_conversation");
  model.retrySubscription();
  stream("A")({
    kind: "conversation",
    conversation: conversation("A", { revision: 2 }),
  });
  expect(model.streamError()).toBe(false);
  expect(model.canSend()).toBe(true);
});

it.each(["select_working_folder", "create_conversation"])(
  "keeps a newer selection when %s completes late",
  async (command) => {
    const pending = deferred<Conversation>();
    commands.set(command, () => pending.promise);
    const model = setup();
    const creating =
      command === "select_working_folder"
        ? model.selectFolder("codex")
        : model.createInFolder("/project", "codex");
    await model.openConversation("B");
    model.setMessage("B draft");
    pending.resolve(conversation("A"));
    await creating;
    expect(model.conversation()?.id).toBe("B");
    expect(model.message()).toBe("B draft");
    expect(model.history()?.some((entry) => entry.id === "A")).toBe(true);
  },
);

it.each(actions)(
  "ignores %s completion after the model owner is disposed",
  async (command, action) => {
    commands.set("get_conversation", async () => running("A"));
    const pending = deferred<Conversation>();
    commands.set(command, () => pending.promise);
    const model = setup();
    await model.openConversation("A");
    model.setMessage("draft");
    const work = action(model);
    dispose();
    pending.resolve(conversation("A", { revision: 2, notice: "late" }));
    await work;
    expect(model.conversation()?.notice).toBeNull();
    expect(model.message()).toBe("draft");
  },
);
