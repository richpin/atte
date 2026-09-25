import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = () => {};
  },
}));
let receiveUpdate: (update: Record<string, unknown>) => void;
let layoutWidth: number;
let resizeObservers: ResizeObserverFixture[];
class ResizeObserverFixture {
  readonly targets = new Set<Element>();

  constructor(readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }
}

function resizeElement(target: Element, width: number) {
  layoutWidth = width;
  const entry = { target, contentRect: { width } } as ResizeObserverEntry;
  for (const observer of resizeObservers) {
    if (observer.targets.has(target)) {
      observer.callback([entry], observer as unknown as ResizeObserver);
    }
  }
}

const receive = (thread: Record<string, unknown>) =>
  receiveUpdate({ kind: "thread", thread });
let pendingSnapshots: Map<string, Record<string, unknown>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function subscribeWith(
  args: unknown,
  snapshot: Record<string, unknown>,
  token = "subscription-1",
) {
  receiveUpdate = (args as { channel: { onmessage: typeof receiveUpdate } })
    .channel.onmessage;
  queueMicrotask(() => receive(snapshot));
  return Promise.resolve(token);
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("shows registry icons and falls back for missing or failed images", async () => {
  const images: HTMLImageElement[] = [];
  const imageConstructor = vi
    .spyOn(window, "Image")
    .mockImplementation(function ImageFixture() {
      const image = document.createElement("img");
      images.push(image);
      return image;
    });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "prepared_agents") return [];
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return [
        {
          id: "available",
          name: "Available",
          icon: "https://cdn.agentclientprotocol.com/available.svg",
        },
        {
          id: "broken",
          name: "Broken",
          icon: "https://cdn.agentclientprotocol.com/broken.svg",
        },
        { id: "missing", name: "Missing", icon: null },
      ].map((agent) => ({ ...agent, authentication: { methods: [] } }));
  });
  try {
    render(() => <App />);
    await openAgentManagement();
    await screen.findByRole("heading", { name: "Available" });
    await waitFor(() => expect(images).toHaveLength(2));
    fireEvent.load(images[0]);
    fireEvent.error(images[1]);
    await waitFor(() => {
      expect(
        screen
          .getByRole("heading", { name: "Available" })
          .closest("article")
          ?.querySelector("img")?.src,
      ).toBe("https://cdn.agentclientprotocol.com/available.svg");
      for (const name of ["Broken", "Missing"]) {
        const row = screen.getByRole("heading", { name }).closest("article");
        expect(row?.querySelector("img")).toBeNull();
        expect(row?.querySelector("svg")).not.toBeNull();
      }
    });
  } finally {
    cleanup();
    imageConstructor.mockRestore();
  }
});
const requests = vi.fn();
beforeEach(() => {
  localStorage.clear();
  pendingSnapshots = new Map();
  layoutWidth = 800;
  resizeObservers = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverFixture);
  vi.resetAllMocks();
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    () => layoutWidth,
  );
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "subscribe_thread_list")
      return Promise.resolve("list-subscription");
    if (command === "list_threads") return Promise.resolve([]);
    if (command === "prepared_agents")
      return Promise.resolve([{ id: "codex", name: "Codex" }]);
    if (command === "subscribe_thread") {
      receiveUpdate = (args as { channel: { onmessage: typeof receiveUpdate } })
        .channel.onmessage;
      const id = (args as { id: string }).id;
      const snapshot =
        pendingSnapshots.get(id) ??
        ((await requests("subscription_snapshot", { id })) as
          | Record<string, unknown>
          | undefined);
      if (snapshot?.id === id) queueMicrotask(() => receive(snapshot));
      return "subscription-1";
    }
    if (command === "unsubscribe_thread") return;
    const result = await requests(command, args);
    if (
      ["select_working_folder", "create_thread"].includes(command) &&
      result &&
      typeof result === "object" &&
      "id" in result
    ) {
      const snapshot = result as Record<string, unknown> & { id: string };
      pendingSnapshots.set(snapshot.id, snapshot);
      return snapshot.id;
    }
    if (
      [
        "connect_thread",
        "send_message",
        "delete_queued_message",
        "cancel_turn",
        "answer_permission",
      ].includes(command)
    ) {
      if (result && typeof result === "object" && "id" in result)
        queueMicrotask(() => receive(result as Record<string, unknown>));
      return;
    }
    return result;
  });
});

function threadMenu(title: string): HTMLButtonElement {
  const row = screen.getByRole("button", { name: title }).parentElement;
  expect(row).not.toBeNull();
  const menu = row?.querySelector<HTMLButtonElement>(
    `[aria-label="${title} 메뉴"]`,
  );
  expect(menu).not.toBeNull();
  return menu as HTMLButtonElement;
}

async function openAgentManagement() {
  await userEvent.click(screen.getByRole("button", { name: "설정 메뉴 열기" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "에이전트" }));
  await waitFor(() =>
    expect(screen.queryByRole("menuitem", { name: "에이전트" })).toBeNull(),
  );
}

it("opens settings pages from the sidebar menu and keeps language selection there", async () => {
  render(() => <App />);

  const settings = screen.getByRole("button", { name: "설정 메뉴 열기" });
  settings.focus();
  expect(document.activeElement).toBe(settings);
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("menuitem", { name: "일반" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "에이전트" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(settings);

  await userEvent.click(settings);
  await userEvent.click(screen.getByRole("menuitem", { name: "일반" }));
  await waitFor(() =>
    expect(screen.queryByRole("menuitem", { name: "일반" })).toBeNull(),
  );
  expect(screen.getByRole("heading", { name: "일반" })).toBeTruthy();
  expect(
    screen.getByText("Atte 전체에서 사용할 언어를 선택합니다."),
  ).toBeTruthy();
  expect(
    screen.getByText("이 기기에서 사용할 Atte의 화면 모드를 선택합니다."),
  ).toBeTruthy();
  const systemTheme = screen.getByRole("radio", { name: "시스템" });
  expect(systemTheme).toHaveProperty("checked", true);

  systemTheme.focus();
  expect(document.activeElement).toBe(systemTheme);
  expect(screen.getByRole("radio", { name: "라이트" })).toBeTruthy();

  await userEvent.click(screen.getByRole("radio", { name: "다크" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  expect(localStorage.getItem("atte.theme")).toBe("dark");

  await userEvent.click(screen.getByRole("radio", { name: "시스템" }));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("atte.theme")).toBe("system");

  await userEvent.click(screen.getByRole("button", { name: "언어" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "English" }));
  expect(await screen.findByRole("heading", { name: "General" })).toBeTruthy();
  expect(localStorage.getItem("atte.locale")).toBe("en");

  await userEvent.click(
    screen.getByRole("button", { name: "Open settings menu" }),
  );
  expect(
    screen
      .getByRole("menuitem", { name: "General" })
      .getAttribute("aria-current"),
  ).toBe("page");
  await userEvent.click(screen.getByRole("menuitem", { name: "Agents" }));
  expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();

  localStorage.removeItem("atte.locale");
});

it("starts on new chat and preserves a thread draft across that navigation", async () => {
  const saved = {
    id: "draft-navigation",
    title: "Draft navigation",
    workingFolder: "/work/project",
    agentId: "codex",
    status: "sessionReady",
    authentication: "authenticated",
    turns: [],
    permissions: [],
    queuedMessages: [],
  };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([saved]);
    if (command === "subscribe_thread") return subscribeWith(args, saved);
    return original?.(command, args) ?? Promise.resolve();
  });

  render(() => <App />);

  expect(
    await screen.findByRole("heading", { name: "어디에서 작업할까요?" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "새 채팅" })
      .getAttribute("aria-current"),
  ).toBe("page");
  await userEvent.click(
    await screen.findByRole("button", { name: saved.title }),
  );
  await userEvent.type(screen.getByRole("textbox"), "preserved draft");
  await userEvent.click(screen.getByRole("button", { name: "새 채팅" }));
  expect(
    screen.getByRole("heading", { name: "어디에서 작업할까요?" }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: saved.title }));
  expect(await screen.findByRole("textbox")).toHaveProperty(
    "value",
    "preserved draft",
  );
});

it("groups threads by folder, collapses projects and creates within the selected folder", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const saved = {
    id: "one",
    title: "First project task",
    workingFolder: "/work/project",
    agentId: "codex",
    status: "sessionReady",
    turns: [],
    permissions: [],
    queuedMessages: [],
  };
  const original = vi.mocked(invoke).getMockImplementation();
  let receiveList!: (entries: unknown[]) => void;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_threads")
      return [saved, { ...saved, id: "two", title: "Second project task" }];
    if (command === "subscribe_thread_list") {
      receiveList = (args as { channel: { onmessage: typeof receiveList } })
        .channel.onmessage;
      return "list";
    }
    if (command === "create_thread") {
      const created = {
        ...saved,
        id: "new",
        title: "새 스레드",
        status: "disconnected",
      };
      pendingSnapshots.set(created.id, created);
      return created.id;
    }
    if (command === "connect_thread") return;
    return original?.(command, args);
  });
  render(() => <App />);
  const project = await screen.findByRole("button", {
    name: "프로젝트 project",
  });
  expect(
    screen.getAllByRole("button", { name: "project에 새 스레드" }),
  ).toHaveLength(1);
  await userEvent.click(project);
  expect(
    screen.queryByRole("button", { name: "First project task" }),
  ).toBeNull();
  await userEvent.click(project);
  receiveList([
    { ...saved, status: "waitingForApproval" },
    { ...saved, id: "two", title: "Second project task" },
  ]);
  expect(
    await screen.findByRole("button", {
      name: /^First project task.*승인 대기$/,
    }),
  ).toBeTruthy();
  const resizeHandle = screen.getByRole("separator", {
    name: "사이드바 너비 조절",
  });
  expect(resizeHandle.getAttribute("aria-valuemin")).toBe("0.28");
  expect(resizeHandle.getAttribute("aria-valuemax")).toBe("0.6");
  const sidebarPanel = resizeHandle.previousElementSibling as HTMLElement;
  const contentPanel = resizeHandle.nextElementSibling as HTMLElement;
  const sidebarHeader = sidebarPanel.querySelector('[data-sidebar="header"]');
  const sidebarContent = sidebarPanel.querySelector('[data-sidebar="content"]');
  const projectThreads = sidebarPanel.querySelector(
    '[data-sidebar="menu-sub"]',
  );
  expect(sidebarPanel.classList.contains("min-w-56")).toBe(true);
  expect(sidebarHeader).not.toBeNull();
  expect(sidebarContent?.classList).toContain("max-w-full");
  expect(sidebarContent?.classList).toContain("overflow-x-hidden");
  expect(projectThreads?.classList).toContain("translate-x-0");
  expect(
    sidebarHeader?.contains(
      screen.getByRole("button", { name: "사이드바 접기" }),
    ),
  ).toBe(true);
  await waitFor(() => expect(sidebarPanel.style.flexBasis).toBe("32%"));
  const resizableRoot = document.querySelector("[data-corvu-resizable-root]");
  expect(resizableRoot).not.toBeNull();
  resizeElement(resizableRoot as Element, 1000);
  await waitFor(() => expect(sidebarPanel.style.flexBasis).toBe("25.6%"));
  fireEvent.keyDown(resizeHandle, { key: "Home" });
  expect(screen.queryByRole("navigation", { name: "스레드 목록" })).toBeNull();
  fireEvent.keyDown(resizeHandle, { key: "Enter" });
  expect(
    await screen.findByRole("navigation", { name: "스레드 목록" }),
  ).toBeTruthy();
  await waitFor(() => expect(sidebarPanel.style.flexBasis).toBe("25.6%"));
  await userEvent.click(screen.getByRole("button", { name: "사이드바 접기" }));
  expect(screen.queryByRole("navigation", { name: "스레드 목록" })).toBeNull();
  expect(
    document.querySelector('[data-collapsible="resizable"]'),
  ).not.toBeNull();
  const expandSidebar = screen.getByRole("button", {
    name: "사이드바 펼치기",
  });
  expect(contentPanel.contains(expandSidebar)).toBe(true);
  await userEvent.click(expandSidebar);
  await userEvent.click(
    screen.getByRole("button", { name: "project에 새 스레드" }),
  );
  expect(invoke).toHaveBeenCalledWith("create_thread", {
    folder: "/work/project",
    agentId: "codex",
  });
  expect(invoke).toHaveBeenCalledWith("connect_thread", { id: "new" });
});

it("presents agent configuration and reconciles it from the thread subscription", async () => {
  let saved: Record<string, unknown> & {
    configuration: Array<
      Record<string, unknown> & {
        id: string;
        currentValue: string | boolean;
      }
    >;
  } = {
    id: "configured",
    title: "Configured thread",
    workingFolder: "/work/project",
    agentId: "codex",
    status: "sessionReady",
    sessionId: "remote-1",
    authentication: "authenticated",
    turns: [],
    permissions: [],
    queuedMessages: [],
    configuration: [
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
            { value: "model-b", name: "Model B", description: null },
          ],
        },
      },
      {
        id: "opaque-effort",
        name: "Reasoning effort",
        description: "Choose how deeply the agent reasons",
        category: "thought_level",
        type: "select",
        currentValue: "balanced",
        options: {
          type: "grouped",
          groups: [
            {
              id: "normal",
              name: "Standard efforts",
              options: [
                {
                  value: "balanced",
                  name: "Balanced",
                  description: "A balanced effort",
                },
                {
                  value: "deep",
                  name: "Deep",
                  description: "More deliberate",
                },
              ],
            },
          ],
        },
      },
      {
        id: "opaque-mode",
        name: "Planning mode",
        description: "Plan before acting",
        category: "mode",
        type: "boolean",
        currentValue: true,
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
                {
                  value: "workspace",
                  name: "Workspace",
                  description: "Only the workspace",
                },
              ],
            },
          ],
        },
      },
      {
        id: "opaque-notifications",
        name: "Notifications",
        description: "Show agent notifications",
        category: null,
        type: "boolean",
        currentValue: false,
      },
    ],
  };
  let completeModelChange!: () => void;
  const modelChange = new Promise<void>((resolve) => {
    completeModelChange = resolve;
  });
  requests.mockImplementation(async (command, args) => {
    if (command === "subscription_snapshot") return saved;
    if (command === "set_thread_configuration") {
      const { configId, value } = args as {
        configId: string;
        value: { type: "select" | "boolean"; value: string | boolean };
      };
      const optimistic = {
        ...saved,
        configuration: saved.configuration.map((configuration) =>
          configuration.id === configId
            ? { ...configuration, currentValue: value.value }
            : configuration,
        ),
      };
      receive(optimistic);
      if (configId === "opaque-model") {
        saved = optimistic;
        return modelChange;
      }
      receive(saved);
      throw new Error("configuration rejected");
    }
    return undefined;
  });
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_threads") return [saved];
    return original?.(command, args);
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Configured thread" }),
  );

  expect(
    screen
      .getByRole("combobox", { name: "Reasoning effort: Balanced" })
      .getAttribute("title"),
  ).toBe("Choose how deeply the agent reasons");
  expect(screen.getByRole("group", { name: "Standard efforts" })).toBeTruthy();
  expect(
    screen
      .getByRole("switch", { name: "Planning mode: 켜짐" })
      .getAttribute("title"),
  ).toBe("Plan before acting");

  const settings = screen.getByText("스레드 설정");
  settings.focus();
  expect(document.activeElement).toBe(settings);
  await userEvent.click(settings);
  expect(settings.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Limit file access")).toBeTruthy();
  expect(screen.getByRole("group", { name: "Safe modes" })).toBeTruthy();
  expect(
    screen.getByRole("switch", { name: "Notifications: 꺼짐" }),
  ).toBeTruthy();

  await userEvent.selectOptions(
    await screen.findByRole("combobox", { name: "Model: Model A" }),
    "model-b",
  );
  expect(invoke).toHaveBeenCalledWith("set_thread_configuration", {
    id: "configured",
    configId: "opaque-model",
    value: { type: "select", value: "model-b" },
  });
  expect(
    await screen.findByRole("combobox", { name: "Model: Model B" }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("textbox", { name: "메시지" }) as HTMLTextAreaElement)
      .disabled,
  ).toBe(false);
  await userEvent.click(
    screen.getByRole("switch", { name: "Planning mode: 켜짐" }),
  );
  expect(invoke).toHaveBeenCalledWith("set_thread_configuration", {
    id: "configured",
    configId: "opaque-mode",
    value: { type: "boolean", value: false },
  });
  expect((await screen.findByRole("alert")).textContent).toContain(
    "configuration rejected",
  );
  expect(
    screen.getByRole("switch", { name: "Planning mode: 켜짐" }),
  ).toBeTruthy();
  const message = screen.getByRole("textbox", { name: "메시지" });
  await userEvent.type(message, "continue{Enter}");
  expect(invoke).toHaveBeenCalledWith("send_message", {
    id: "configured",
    input: { text: "continue", attachments: [] },
  });
  completeModelChange();

  receive({ ...saved, status: "connecting", configuration: [] });
  await waitFor(() =>
    expect(screen.queryByRole("combobox", { name: /Model:/ })).toBeNull(),
  );

  receive(saved);
  expect(
    await screen.findByRole("switch", { name: "Planning mode: 켜짐" }),
  ).toBeTruthy();
});

it("keeps cancellation and permission responses usable during configuration reconciliation", async () => {
  const saved = {
    id: "active-configured",
    title: "Active configured thread",
    workingFolder: "/work/project",
    agentId: "codex",
    status: "running",
    sessionId: "remote-1",
    authentication: "authenticated",
    turns: [
      {
        id: "turn-1",
        message: "work",
        response: "working",
        stopReason: null,
      },
    ],
    permissions: [],
    queuedMessages: [],
    configuration: [
      {
        id: "opaque-model",
        name: "Model",
        description: null,
        category: "model",
        type: "select",
        currentValue: "model-a",
        options: {
          type: "flat",
          options: [
            { value: "model-a", name: "Model A", description: null },
            { value: "model-b", name: "Model B", description: null },
          ],
        },
      },
      {
        id: "opaque-effort",
        name: "Reasoning effort",
        description: null,
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: {
          type: "flat",
          options: [
            { value: "medium", name: "Medium", description: null },
            { value: "high", name: "High", description: null },
          ],
        },
      },
    ],
  };
  let finishConfiguration!: () => void;
  const configurationRequest = new Promise<void>((resolve) => {
    finishConfiguration = resolve;
  });
  requests.mockImplementation(async (command) => {
    if (command === "subscription_snapshot") return saved;
    if (command === "set_thread_configuration") {
      receive({
        ...saved,
        configuration: [
          { ...saved.configuration[0], currentValue: "model-b" },
          saved.configuration[1],
        ],
      });
      return configurationRequest;
    }
    return undefined;
  });
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_threads") return [saved];
    return original?.(command, args);
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", {
      name: /^Active configured thread(?! 메뉴)/,
    }),
  );

  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "Model: Model A" }),
    "model-b",
  );
  expect(
    await screen.findByRole("combobox", { name: "Model: Model B" }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "현재 작업 중단" }));
  expect(invoke).toHaveBeenCalledWith("cancel_turn", {
    id: "active-configured",
    turn: "turn-1",
  });

  const waiting = {
    ...saved,
    status: "waitingForApproval",
    permissions: [
      {
        id: "permission-1",
        title: "Write file",
        details: "fixture.txt",
        options: [{ id: "allow", name: "Allow once" }],
      },
    ],
    configuration: [
      { ...saved.configuration[0], currentValue: "model-b" },
      {
        ...saved.configuration[1],
        currentValue: "low",
        options: {
          type: "flat",
          options: [{ value: "low", name: "Low", description: null }],
        },
      },
    ],
  };
  receive(waiting);
  await userEvent.click(
    await screen.findByRole("button", { name: "Allow once" }),
  );
  expect(invoke).toHaveBeenCalledWith("answer_permission", {
    id: "active-configured",
    request: "permission-1",
    option: "allow",
  });
  expect(
    screen.getByRole("combobox", { name: "Reasoning effort: Low" }),
  ).toBeTruthy();
  expect(screen.queryByRole("option", { name: "High" })).toBeNull();
  finishConfiguration();
});

it("opens the same delete action from the row menu and right click, then cancels safely", async () => {
  const saved = {
    id: "delete-me",
    title: "삭제할 초안",
    workingFolder: "/work/project",
    agentId: "codex",
    status: "disconnected",
    sessionId: "remote-delete-me",
  };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_threads") return [saved];
    if (command === "subscribe_thread_list") return "list";
    if (command === "prepared_agents") return [{ id: "codex", name: "Codex" }];
  });
  render(() => <App />);

  await userEvent.click(
    await screen.findByRole("button", { name: "삭제할 초안 메뉴" }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "삭제" }));
  expect(
    screen.getByRole("heading", { name: "스레드를 삭제할까요?" }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "이 스레드가 영구적으로 삭제됩니다. 이 작업은 취소할 수 없습니다.",
    ),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "취소" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "delete_thread"),
  ).toBe(false);

  const menu = await waitFor(() => threadMenu("삭제할 초안"));
  const row = menu.parentElement;
  if (!row) throw new Error("thread menu must belong to its row");
  fireEvent.contextMenu(row);
  expect(await screen.findByRole("menuitem", { name: "삭제" })).toBeTruthy();
});

it("keeps confirmation open while deleting the selected thread and ignores late updates", async () => {
  const selected = {
    id: "selected",
    title: "현재 스레드",
    workingFolder: "/work/project",
    agentId: "codex",
    status: "sessionReady",
    sessionId: null,
    authentication: "authenticated",
    turns: [],
    permissions: [],
    queuedMessages: [],
  };
  const other = { ...selected, id: "other", title: "남은 스레드" };
  let receiveList!: (entries: (typeof selected)[]) => void;
  let finishDelete!: () => void;
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([selected, other]);
    if (command === "subscribe_thread") return subscribeWith(args, selected);
    if (command === "subscribe_thread_list") {
      receiveList = (args as { channel: { onmessage: typeof receiveList } })
        .channel.onmessage;
      return Promise.resolve("list");
    }
    if (command === "delete_thread")
      return new Promise<void>((resolve) => {
        finishDelete = resolve;
      });
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "현재 스레드" }),
  );
  await userEvent.type(screen.getByRole("textbox"), "작성 중인 입력");
  await userEvent.click(threadMenu("현재 스레드"));
  await userEvent.click(screen.getByRole("menuitem", { name: "삭제" }));
  await userEvent.click(screen.getByRole("button", { name: "삭제" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(screen.getByRole("button", { name: "삭제 중…" })).toHaveProperty(
    "disabled",
    true,
  );

  finishDelete();
  expect(
    await screen.findByRole("heading", { name: "어디에서 작업할까요?" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "현재 스레드" })).toBeNull();
  expect(screen.getByRole("button", { name: "남은 스레드" })).toBeTruthy();
  receiveList([selected, other]);
  expect(screen.queryByRole("button", { name: "현재 스레드" })).toBeNull();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([command, args]) =>
          command === "unsubscribe_thread" &&
          (args as { subscription?: string }).subscription === "subscription-1",
      ),
  ).toBe(true);
});

it("does not reopen a deleted thread when an overlapping open finishes late", async () => {
  const saved = {
    id: "late-open",
    title: "느린 스레드",
    workingFolder: "/work/project",
    agentId: "codex",
    status: "disconnected",
    sessionId: null,
    turns: [],
    permissions: [],
    queuedMessages: [],
  };
  let finishOpen!: (thread: typeof saved) => void;
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([saved]);
    if (command === "subscribe_thread") {
      receiveUpdate = (args as { channel: { onmessage: typeof receiveUpdate } })
        .channel.onmessage;
      finishOpen = (thread) => receive(thread);
      return Promise.resolve("late-open");
    }
    if (command === "delete_thread") return Promise.resolve();
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "느린 스레드" }),
  );
  await userEvent.click(threadMenu("느린 스레드"));
  await userEvent.click(screen.getByRole("menuitem", { name: "삭제" }));
  await userEvent.click(screen.getByRole("button", { name: "삭제" }));
  finishOpen(saved);

  expect(
    await screen.findByRole("heading", { name: "어디에서 작업할까요?" }),
  ).toBeTruthy();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "connect_thread"),
  ).toBe(false);
});

it("preserves the selected thread and draft when deleting another thread", async () => {
  const current = {
    id: "current",
    title: "계속 작업",
    workingFolder: "/work/project",
    agentId: "codex",
    status: "sessionReady",
    authentication: "authenticated",
    turns: [],
    permissions: [],
    queuedMessages: [],
  };
  const other = { ...current, id: "other", title: "다른 스레드" };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([current, other]);
    if (command === "subscribe_thread") return subscribeWith(args, current);
    if (command === "delete_thread") return Promise.resolve();
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "계속 작업" }),
  );
  await userEvent.type(screen.getByRole("textbox"), "유지할 입력");
  await userEvent.click(threadMenu("다른 스레드"));
  await userEvent.click(screen.getByRole("menuitem", { name: "삭제" }));
  await userEvent.click(screen.getByRole("button", { name: "삭제" }));

  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "다른 스레드" })).toBeNull(),
  );
  expect(
    screen.getByRole("heading", { name: "계속 작업", hidden: true }),
  ).toBeTruthy();
  expect(screen.getByRole("textbox", { hidden: true })).toHaveProperty(
    "value",
    "유지할 입력",
  );
});

it("keeps the thread and allows retry after local deletion fails", async () => {
  const saved = {
    id: "failure",
    title: "실패할 삭제",
    workingFolder: "/work/project",
    agentId: "codex",
    status: "disconnected",
  };
  let attempts = 0;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_threads") return [saved];
    if (command === "subscribe_thread_list") return "list";
    if (command === "prepared_agents") return [{ id: "codex", name: "Codex" }];
    if (command === "delete_thread") {
      attempts++;
      if (attempts === 1)
        throw { code: "unavailable", message: "로컬 저장소 오류" };
    }
  });
  render(() => <App />);
  await screen.findByRole("button", { name: "실패할 삭제" });
  await userEvent.click(threadMenu("실패할 삭제"));
  await userEvent.click(screen.getByRole("menuitem", { name: "삭제" }));
  await userEvent.click(screen.getByRole("button", { name: "삭제" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "로컬 저장소 오류",
  );
  expect(screen.getByText("실패할 삭제")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "삭제" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(attempts).toBe(2);
});

it("keeps the saved list accessible without agents and restores on selection only", async () => {
  const saved = {
    id: "saved-1",
    title: "지난 작업",
    agentId: "missing-agent",
    workingFolder: "/project",
    status: "disconnected",
    sessionId: "remote-7",
    turns: [],
    permissions: [],
    failure: null,
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "prepared_agents" || command === "agent_catalog") return [];
    if (command === "list_threads") return [saved];
    if (command === "connect_thread") {
      queueMicrotask(() =>
        receive({
          ...saved,
          status: "failed",
          failure: "agentRemoved",
        }),
      );
      return;
    }
    if (command === "subscribe_thread") {
      receiveUpdate = (args as { channel: { onmessage: typeof receiveUpdate } })
        .channel.onmessage;
      queueMicrotask(() => receive(saved));
      return "subscription";
    }
  });
  render(() => <App />);
  await screen.findByRole("button", { name: "지난 작업" });
  expect(screen.getByRole("button", { name: "지난 작업 메뉴" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "에이전트" })).toBeNull();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "connect_thread"),
  ).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "지난 작업" }));
  await screen.findByText(/에이전트를 설치한 뒤/);
  await userEvent.click(
    screen.getByRole("button", { name: "설치·인증 관리 열기" }),
  );
  await screen.findByRole("heading", { name: "에이전트" });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "send_message"),
  ).toBe(false);
});

it("loads selected history once and keeps newer list metadata when an older thread arrives", async () => {
  const saved = {
    id: "saved-1",
    title: "저장된 제목",
    agentId: "codex",
    workingFolder: "/project",
    status: "disconnected",
    sessionId: "remote-7",
    turns: [],
    permissions: [],
    failure: null,
  };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([saved]);
    if (command === "subscribe_thread") return subscribeWith(args, saved);
    if (command === "connect_thread") {
      queueMicrotask(() => receive({ ...saved, status: "connecting" }));
      return Promise.resolve();
    }
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "저장된 제목" }),
  );
  await screen.findByText("이전 스레드를 불러오는 중…");
  expect(screen.getByRole("heading", { name: "저장된 제목" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "전송" })).toHaveProperty(
    "disabled",
    true,
  );
  receive({
    ...saved,
    title: "복원한 제목",
    status: "sessionReady",
    turns: [
      {
        id: "old-turn",
        message: "과거 질문",
        response: "과거 답변",
        stopReason: null,
      },
    ],
  });
  expect(await screen.findAllByText("과거 답변")).toHaveLength(1);
  expect(
    await screen.findByRole("button", { name: "복원한 제목" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "저장된 제목" })).toBeNull();
  expect(screen.getByRole("heading", { name: "복원한 제목" })).toBeTruthy();
  await userEvent.type(screen.getByRole("textbox"), "작성 중인 질문");
  await userEvent.click(screen.getByRole("button", { name: "복원한 제목" }));
  expect(screen.getByRole("textbox")).toHaveProperty("value", "작성 중인 질문");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "connect_thread"),
  ).toHaveLength(1);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "send_message"),
  ).toBe(false);
});

it("keeps authentication discovery failures inline and retries on request", async () => {
  const saved = {
    id: "saved-auth",
    title: "인증이 필요한 작업",
    agentId: "codex",
    workingFolder: "/project",
    status: "disconnected",
    sessionId: "same-remote",
    turns: [],
    permissions: [],
    failure: null,
  };
  let connectAttempts = 0;
  let discoveryAttempts = 0;
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([saved]);
    if (command === "subscribe_thread") return subscribeWith(args, saved);
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return Promise.resolve([]);
    if (command === "authenticate_agent") {
      discoveryAttempts++;
      if (discoveryAttempts === 1) return Promise.reject("temporary failure");
      return Promise.resolve({
        connected: true,
        authenticated: false,
        required: true,
        methods: [
          {
            id: "browser",
            name: "Continue in browser",
            description: null,
            terminal: false,
            supported: true,
          },
        ],
      });
    }
    if (command === "connect_thread") {
      expect(args).toEqual({ id: saved.id });
      connectAttempts++;
      queueMicrotask(() =>
        receive({
          ...saved,
          status: "failed",
          authentication: "required",
          failure: "authenticationRequired",
        }),
      );
      return Promise.resolve();
    }
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "인증이 필요한 작업" }),
  );
  expect(await screen.findByText("temporary failure")).toBeTruthy();
  expect(connectAttempts).toBe(1);
  expect(discoveryAttempts).toBe(1);
  await userEvent.click(
    await screen.findByRole("button", { name: "다시 시도" }),
  );
  expect(
    screen
      .getAllByRole("button", { name: new RegExp(`^${saved.title}`) })
      .some((button) => button.getAttribute("aria-current") === "page"),
  ).toBe(true);
  expect(
    await screen.findByRole("button", { name: "Continue in browser" }),
  ).toBeTruthy();
  expect(discoveryAttempts).toBe(2);
  expect(connectAttempts).toBe(1);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "send_message"),
  ).toBe(false);
});

it("automatically connects a new thread and disables sending while connecting", async () => {
  const draft = {
    turns: [],
    authentication: "unknown",
    id: "draft-1",
    workingFolder: "/Users/test/작업",
    agentId: "codex",
    status: "disconnected",
  };
  requests
    .mockResolvedValueOnce(draft)
    .mockResolvedValueOnce({ ...draft, status: "connecting" });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(
    (await screen.findByRole("button", { name: "새 스레드" })).getAttribute(
      "aria-current",
    ),
  ).toBe("page");
  expect(screen.getByText("에이전트에 연결 중…")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("connect_thread", {
    id: "draft-1",
  });
  expect(screen.queryByRole("button", { name: "에이전트 연결" })).toBeNull();
  expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(
    true,
  );
  expect(
    (screen.getByRole("button", { name: "전송" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("keeps the initial screen when folder selection is cancelled", async () => {
  requests.mockResolvedValueOnce(null);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(
    screen.getByRole("heading", { name: "어디에서 작업할까요?" }),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("connect_thread", expect.anything());
});

it("shows folder errors and lets the user retry", async () => {
  requests.mockRejectedValueOnce({
    code: "invalidWorkingFolder",
    message: "존재하는 작업 폴더를 선택해주세요.",
  });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "존재하는 작업 폴더를 선택해주세요.",
  );
  expect(
    (screen.getByRole("button", { name: "폴더 선택" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it("keeps the new chat page when another folder selection is cancelled", async () => {
  requests
    .mockResolvedValueOnce({
      id: "draft-1",
      workingFolder: "/Users/test/project",
      agentId: "codex",
      status: "disconnected",
    })
    .mockResolvedValueOnce({
      id: "draft-1",
      workingFolder: "/Users/test/project",
      agentId: "codex",
      status: "sessionReady",
    })
    .mockResolvedValueOnce(null);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await screen.findByRole("textbox");
  await userEvent.click(screen.getByRole("button", { name: "새 채팅" }));
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(
    screen.getByRole("heading", { name: "어디에서 작업할까요?" }),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("disables folder selection until the native dialog completes", async () => {
  let finish!: (value: null) => void;
  requests.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(
    (screen.getByRole("button", { name: "선택 중…" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  finish(null);
  expect(
    (
      (await screen.findByRole("button", {
        name: "폴더 선택",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it("connects the fixed agent and displays backend readiness separately from authentication", async () => {
  requests.mockImplementation(async (command) => {
    if (command === "select_working_folder")
      return {
        turns: [],
        authentication: "unknown",
        id: "draft-1",
        workingFolder: "/project",
        agentId: "codex",
        status: "disconnected",
      };
    if (command === "connect_thread")
      return {
        turns: [],
        authentication: "unknown",
        id: "draft-1",
        workingFolder: "/project",
        agentId: "codex",
        status: "connecting",
      };
    return {
      id: "draft-1",
      workingFolder: "/project",
      agentId: "codex",
      status: "sessionReady",
      authentication: "unknown",
      sessionId: "remote-1",
    };
  });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(await screen.findByText("에이전트에 연결 중…")).toBeTruthy();
  receive({
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    turns: [],
    authentication: "unknown",
  });
  expect(await screen.findByText("스레드가 준비되었습니다")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  expect(
    screen.getByText("인증 상태는 아직 확인되지 않았습니다."),
  ).toBeTruthy();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("connect_thread", {
    id: "draft-1",
  });
});

it("keeps the authentication explanation without duplicate timeline actions", async () => {
  const draft = {
    turns: [],
    authentication: "unknown",
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "disconnected",
  };
  let thread = draft;
  requests.mockImplementation(async (command) => {
    if (command === "authenticate_agent")
      return {
        connected: true,
        authenticated: false,
        required: true,
        methods: [
          {
            id: "browser",
            name: "Continue in browser",
            description: null,
            terminal: false,
            supported: true,
          },
        ],
      };
    if (command === "select_working_folder") return draft;
    if (command === "connect_thread") {
      thread = { ...draft, status: "failed" };
      return {
        ...thread,
        authentication: "required",
        failure: "authenticationRequired",
      };
    }
    return {
      ...thread,
      authentication: "required",
      failure: "authenticationRequired",
    };
  });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(await screen.findByText(/에이전트 로그인이 필요합니다/)).toBeTruthy();
  expect(
    screen.queryByText("인증 상태는 아직 확인되지 않았습니다."),
  ).toBeNull();
  expect(
    requests.mock.calls.filter(([command]) => command === "connect_thread"),
  ).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  expect(screen.queryByRole("button", { name: "로그인 안내 열기" })).toBeNull();
  expect(
    await screen.findByRole("button", { name: "Continue in browser" }),
  ).toBeTruthy();
});

it("replaces the composer with the agent's supported login methods", async () => {
  const authentication = deferred<Record<string, unknown>>();
  const failed = {
    id: "auth-thread",
    title: "Private work",
    workingFolder: "/project",
    agentId: "codex",
    status: "failed",
    authentication: "required",
    failure: "authenticationRequired",
    sessionId: null,
    createdAt: 1,
    updatedAt: 1,
    lastPromptAt: 1,
    interrupted: false,
    storageError: null,
    turns: [],
    notice: null,
    permissions: [],
    queuedMessages: [],
  };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([failed]);
    if (command === "subscribe_thread") return subscribeWith(args, failed);
    if (command === "authenticate_agent") return authentication.promise;
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);

  const title = await screen.findByText("Private work");
  const threadButton = title.closest("button");
  if (!threadButton) throw new Error("thread title must belong to its button");
  await userEvent.click(threadButton);
  expect(await screen.findByText("로그인 방법을 불러오는 중…")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("authenticate_agent", {
    id: "codex",
    method: null,
  });

  authentication.resolve({
    connected: true,
    authenticated: false,
    required: true,
    methods: [
      {
        id: "browser",
        name: "Continue in browser",
        description: "Use your existing account",
        terminal: false,
        supported: true,
      },
      {
        id: "terminal",
        name: "Continue in Terminal",
        description: null,
        terminal: true,
        supported: true,
      },
      {
        id: "future",
        name: "Future protocol",
        description: null,
        terminal: false,
        supported: false,
      },
    ],
  });

  const buttons = await screen.findAllByRole("button", { name: /Continue/ });
  expect(buttons.map((button) => button.textContent)).toEqual([
    "Continue in browser",
    "Continue in Terminal",
  ]);
  expect(screen.getByText("Use your existing account")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Future protocol" })).toBeNull();
  expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  expect(screen.queryByRole("button", { name: "로그인 안내 열기" })).toBeNull();
});

it("shares agent login progress and ignores completion after cancellation", async () => {
  const login = deferred<Record<string, unknown>>();
  const cancellation = deferred<void>();
  const failed = (id: string, title: string) => ({
    id,
    title,
    workingFolder: "/project",
    agentId: "codex",
    status: "failed",
    authentication: "required",
    failure: "authenticationRequired",
    sessionId: null,
    createdAt: 1,
    updatedAt: 1,
    lastPromptAt: 1,
    interrupted: false,
    storageError: null,
    turns: [],
    notice: null,
    permissions: [],
    queuedMessages: [],
  });
  const first = failed("auth-a", "First private thread");
  const second = failed("auth-b", "Second private thread");
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([first, second]);
    if (command === "subscribe_thread") {
      const id = (args as { id: string }).id;
      return subscribeWith(args, id === first.id ? first : second, id);
    }
    if (command === "authenticate_agent") {
      if ((args as { method: string | null }).method) return login.promise;
      return Promise.resolve({
        connected: true,
        authenticated: false,
        required: true,
        methods: [
          {
            id: "browser",
            name: "Continue in browser",
            description: null,
            terminal: false,
            supported: true,
          },
        ],
      });
    }
    if (command === "cancel_agent_authentication") return cancellation.promise;
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);

  const firstTitle = await screen.findByText("First private thread");
  await userEvent.click(firstTitle.closest("button") as HTMLButtonElement);
  await userEvent.click(
    await screen.findByRole("button", { name: "Continue in browser" }),
  );
  expect(
    await screen.findByText("Continue in browser 로그인 진행 중"),
  ).toBeTruthy();

  const secondTitle = screen.getByText("Second private thread");
  await userEvent.click(secondTitle.closest("button") as HTMLButtonElement);
  expect(
    await screen.findByText("Continue in browser 로그인 진행 중"),
  ).toBeTruthy();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command, args]) =>
          command === "authenticate_agent" &&
          (args as { method?: string }).method === "browser",
      ),
  ).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: "로그인 취소" }));
  expect(invoke).toHaveBeenCalledWith("cancel_agent_authentication", {
    id: "codex",
  });
  expect(screen.getByText("Continue in browser 로그인 진행 중")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Continue in browser" }),
  ).toBeNull();

  cancellation.resolve();
  expect(
    await screen.findByRole("button", { name: "Continue in browser" }),
  ).toBeTruthy();

  login.resolve({
    connected: true,
    authenticated: true,
    required: false,
    methods: [],
  });
  await Promise.resolve();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "connect_thread"),
  ).toBe(false);
  expect(
    screen.getByRole("button", { name: "Continue in browser" }),
  ).toBeTruthy();
});

it("does not reconnect another same-agent authentication failure when login completes", async () => {
  const login = deferred<Record<string, unknown>>();
  const failed = (id: string, title: string) => ({
    id,
    title,
    workingFolder: "/project",
    agentId: "codex",
    status: "failed",
    authentication: "required",
    failure: "authenticationRequired",
    sessionId: null,
    createdAt: 1,
    updatedAt: 1,
    lastPromptAt: 1,
    interrupted: false,
    storageError: null,
    turns: [],
    notice: null,
    permissions: [],
    queuedMessages: [],
  });
  const origin = failed("auth-origin", "Login origin");
  const other = failed("auth-other", "Other private thread");
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([origin, other]);
    if (command === "subscribe_thread") {
      const id = (args as { id: string }).id;
      return subscribeWith(args, id === origin.id ? origin : other, id);
    }
    if (command === "authenticate_agent") {
      if ((args as { method: string | null }).method) return login.promise;
      return Promise.resolve({
        connected: true,
        authenticated: false,
        required: true,
        methods: [
          {
            id: "browser",
            name: "Continue in browser",
            description: null,
            terminal: false,
            supported: true,
          },
        ],
      });
    }
    if (command === "connect_thread") return Promise.resolve();
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);

  await screen.findByText("Login origin");
  await userEvent.click(
    screen.getByText("Login origin").closest("button") as HTMLButtonElement,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Continue in browser" }),
  );
  await userEvent.click(
    screen
      .getByText("Other private thread")
      .closest("button") as HTMLButtonElement,
  );

  login.resolve({
    connected: true,
    authenticated: true,
    required: false,
    methods: [],
  });
  await Promise.resolve();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "connect_thread"),
  ).toHaveLength(0);

  await userEvent.click(
    screen.getByText("Login origin").closest("button") as HTMLButtonElement,
  );
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "connect_thread"),
    ).toHaveLength(1),
  );
});

it("reconnects the still-selected origin once without sending preserved input", async () => {
  const login = deferred<Record<string, unknown>>();
  const ready = {
    id: "auth-origin",
    title: "Private work",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    authentication: "unknown",
    failure: null,
    sessionId: "remote-1",
    createdAt: 1,
    updatedAt: 1,
    lastPromptAt: 1,
    interrupted: false,
    storageError: null,
    turns: [],
    notice: null,
    permissions: [],
    queuedMessages: [],
  };
  const failed = {
    ...ready,
    status: "failed",
    authentication: "required",
    failure: "authenticationRequired",
    queuedMessages: [{ id: "queued", text: "wait for me" }],
  };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([ready]);
    if (command === "subscribe_thread") return subscribeWith(args, ready);
    if (command === "authenticate_agent") {
      if ((args as { method: string | null }).method) return login.promise;
      return Promise.resolve({
        connected: true,
        authenticated: false,
        required: true,
        methods: [
          {
            id: "browser",
            name: "Continue in browser",
            description: null,
            terminal: false,
            supported: true,
          },
        ],
      });
    }
    if (command === "connect_thread") return Promise.resolve();
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);

  const title = await screen.findByText("Private work");
  await userEvent.click(title.closest("button") as HTMLButtonElement);
  await userEvent.type(await screen.findByRole("textbox"), "keep this draft");
  receive(failed);
  expect(await screen.findByText("wait for me")).toBeTruthy();
  await userEvent.click(
    await screen.findByRole("button", { name: "Continue in browser" }),
  );

  login.resolve({
    connected: true,
    authenticated: true,
    required: false,
    methods: [],
  });
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "connect_thread"),
    ).toHaveLength(1),
  );
  receive({ ...ready, queuedMessages: failed.queuedMessages });
  expect(await screen.findByRole("textbox")).toHaveProperty(
    "value",
    "keep this draft",
  );
  expect(screen.getByText("wait for me")).toBeTruthy();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "send_message"),
  ).toBe(false);
});

it("defers reconnect after navigation and reconnects once when the failed thread returns", async () => {
  const login = deferred<Record<string, unknown>>();
  const failed = {
    id: "auth-later",
    title: "Private work",
    workingFolder: "/project",
    agentId: "codex",
    status: "failed",
    authentication: "required",
    failure: "authenticationRequired",
    sessionId: null,
    createdAt: 2,
    updatedAt: 2,
    lastPromptAt: 2,
    interrupted: false,
    storageError: null,
    turns: [],
    notice: null,
    permissions: [],
    queuedMessages: [],
  };
  const other = {
    ...failed,
    id: "other",
    title: "Other work",
    status: "sessionReady",
    authentication: "authenticated",
    failure: null,
    sessionId: "remote-other",
    lastPromptAt: 1,
  };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([failed, other]);
    if (command === "subscribe_thread") {
      const id = (args as { id: string }).id;
      return subscribeWith(args, id === failed.id ? failed : other, id);
    }
    if (command === "authenticate_agent") {
      if ((args as { method: string | null }).method) return login.promise;
      return Promise.resolve({
        connected: true,
        authenticated: false,
        required: true,
        methods: [
          {
            id: "browser",
            name: "Continue in browser",
            description: null,
            terminal: false,
            supported: true,
          },
        ],
      });
    }
    if (command === "connect_thread") return Promise.resolve();
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);

  await screen.findByText("Private work");
  const privateRow = screen.getByText("Private work").closest("button");
  if (!privateRow) throw new Error("thread title must belong to its button");
  await userEvent.click(privateRow);
  await userEvent.click(
    await screen.findByRole("button", { name: "Continue in browser" }),
  );
  const otherTitle = screen.getByText("Other work");
  await userEvent.click(otherTitle.closest("button") as HTMLButtonElement);
  login.resolve({
    connected: true,
    authenticated: true,
    required: false,
    methods: [],
  });
  await Promise.resolve();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "connect_thread"),
  ).toBe(false);

  await userEvent.click(
    screen.getByText("Private work").closest("button") as HTMLButtonElement,
  );
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "connect_thread"),
    ).toHaveLength(1),
  );
  await userEvent.click(
    screen.getByText("Other work").closest("button") as HTMLButtonElement,
  );
  await userEvent.click(
    screen.getByText("Private work").closest("button") as HTMLButtonElement,
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "connect_thread"),
  ).toHaveLength(1);
});

it("returns to login methods when the authenticated reconnect still requires authentication", async () => {
  const failed = {
    id: "auth-again",
    title: "Private work",
    workingFolder: "/project",
    agentId: "codex",
    status: "failed",
    authentication: "required",
    failure: "authenticationRequired",
    sessionId: null,
    createdAt: 1,
    updatedAt: 1,
    lastPromptAt: 1,
    interrupted: false,
    storageError: null,
    turns: [],
    notice: null,
    permissions: [],
    queuedMessages: [],
  };
  const methodResult = {
    connected: true,
    authenticated: false,
    required: true,
    methods: [
      {
        id: "browser",
        name: "Continue in browser",
        description: null,
        terminal: false,
        supported: true,
      },
    ],
  };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([failed]);
    if (command === "subscribe_thread") return subscribeWith(args, failed);
    if (command === "authenticate_agent")
      return Promise.resolve(
        (args as { method: string | null }).method
          ? { ...methodResult, authenticated: true, required: false }
          : methodResult,
      );
    if (command === "connect_thread") return Promise.resolve();
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);

  const title = await screen.findByText("Private work");
  await userEvent.click(title.closest("button") as HTMLButtonElement);
  await userEvent.click(
    await screen.findByRole("button", { name: "Continue in browser" }),
  );
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "connect_thread"),
    ).toHaveLength(1),
  );
  receive({ ...failed, status: "connecting", failure: null });
  expect(await screen.findByText("에이전트에 연결 중…")).toBeTruthy();
  receive(failed);

  expect(
    await screen.findByRole("button", { name: "Continue in browser" }),
  ).toBeTruthy();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command, args]) =>
          command === "authenticate_agent" &&
          (args as { method: string | null }).method === null,
      ),
  ).toHaveLength(2);
});

it("shows process exit after readiness without reconnecting automatically", async () => {
  const draft = {
    turns: [],
    authentication: "unknown",
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "disconnected",
  };
  requests.mockImplementation(async (command) => {
    if (command === "select_working_folder") return draft;
    if (command === "connect_thread")
      return { ...draft, status: "sessionReady" };
    return { ...draft, status: "failed", failure: "processExited" };
  });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(await screen.findByText("스레드가 준비되었습니다")).toBeTruthy();
  receive({
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "failed",
    failure: "processExited",
    turns: [],
  });
  expect((await screen.findByRole("alert")).textContent).toContain(
    "프로세스가 종료",
  );
  expect(
    requests.mock.calls.filter(([command]) => command === "connect_thread"),
  ).toHaveLength(1);
});

it("keeps the existing thread's agent fixed when selecting a target for the next one", async () => {
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "list_threads"
      ? Promise.resolve([])
      : command === "prepared_agents"
        ? Promise.resolve([
            { id: "codex", name: "Codex" },
            { id: "fixture", name: "Fixture" },
          ])
        : (original?.(command, args) ?? Promise.resolve()),
  );
  requests.mockResolvedValue({
    turns: [],
    authentication: "unknown",
    id: "draft-1",
    workingFolder: "/project",
    agentId: "fixture",
    status: "disconnected",
  });
  render(() => <App />);
  await screen.findByRole("option", { name: "Fixture" });
  await userEvent.selectOptions(screen.getByRole("combobox"), "fixture");
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(invoke).toHaveBeenCalledWith("select_working_folder", {
    agentId: "fixture",
    dialogTitle: "작업 폴더 선택",
  });
  expect(invoke).toHaveBeenCalledWith("connect_thread", {
    id: "draft-1",
  });
  await userEvent.click(screen.getByRole("button", { name: "새 채팅" }));
  await userEvent.selectOptions(screen.getByRole("combobox"), "codex");
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
    "codex",
  );
});

it("reports prepared-agent loading failure without crashing the page", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_threads") return [];
    throw new Error("offline");
  });
  render(() => <App />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "에이전트를 불러올 수 없습니다",
  );
  expect(
    (screen.getByRole("button", { name: "폴더 선택" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("shows a removed working folder error from the connection command", async () => {
  requests.mockImplementation(async (command) => {
    if (command === "connect_thread")
      throw {
        code: "invalidWorkingFolder",
        message: "작업 폴더를 찾을 수 없습니다. 폴더를 다시 선택해주세요.",
      };
    return {
      id: "draft-1",
      workingFolder: "/project",
      agentId: "codex",
      status: "disconnected",
    };
  });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "폴더를 다시 선택해주세요",
  );
  expect(screen.getByRole("button", { name: "다시 연결" })).toBeTruthy();
  expect(
    requests.mock.calls.filter(([command]) => command === "connect_thread"),
  ).toHaveLength(1);
});

it("sends with Enter, inserts a newline with Shift+Enter, and preserves IME composition", async () => {
  const ready = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    turns: [],
  };
  requests.mockResolvedValue(ready);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  const input = screen.getByRole("textbox");
  await userEvent.type(input, "첫 줄");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(input, { key: "Enter", repeat: true });
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  await userEvent.type(input, "둘째 줄");
  expect(input).toHaveProperty("value", "첫 줄\n둘째 줄");
  expect(
    requests.mock.calls.filter(([command]) => command === "send_message"),
  ).toHaveLength(0);
  await userEvent.keyboard("{Enter}");
  expect(requests).toHaveBeenCalledWith("send_message", {
    id: "draft-1",
    input: { text: "첫 줄\n둘째 줄", attachments: [] },
  });
  await waitFor(() => expect(input).toHaveProperty("value", ""));
  await userEvent.keyboard("{Enter}");
  expect(
    requests.mock.calls.filter(([command]) => command === "send_message"),
  ).toHaveLength(1);
});

it("focuses the message input when the conversation becomes ready", async () => {
  const connecting = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "connecting",
    turns: [],
  };
  requests.mockResolvedValue(connecting);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));

  const input = screen.getByRole("textbox");
  expect(document.activeElement).not.toBe(input);

  receive({ ...connecting, status: "sessionReady" });

  await waitFor(() => expect(document.activeElement).toBe(input));
});

it("lays the composer over the full-height timeline and reserves its measured height", async () => {
  const observers: Array<{
    callback: ResizeObserverCallback;
    targets: Element[];
  }> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly record: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: [] };
        observers.push(this.record);
      }
      observe(target: Element) {
        this.record.targets.push(target);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const ready = {
    id: "layout",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    turns: [],
    permissions: [],
    queuedMessages: [],
  };
  requests.mockResolvedValue(ready);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));

  const viewport = screen.getByRole("region", { name: "스레드 타임라인" });
  const form = document.querySelector("form");
  expect(form).not.toBeNull();
  const overlay = form?.parentElement?.parentElement as HTMLElement;
  expect(overlay.classList).toContain("absolute");
  expect(overlay.classList).toContain("bottom-4");
  expect(viewport.parentElement?.classList).toContain("h-full");
  const observer = observers.find(({ targets }) => targets.includes(overlay));
  expect(observer).toBeDefined();
  observer?.callback(
    [
      {
        target: overlay,
        contentRect: { height: 160 },
      } as unknown as ResizeObserverEntry,
    ],
    {} as ResizeObserver,
  );
  expect(viewport.style.scrollPaddingBottom).toBe("224px");
});

it("sends once, renders streaming text and completion, and admits the next message", async () => {
  const ready = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    turns: [],
  };
  requests.mockResolvedValue(ready);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  const input = screen.getByRole("textbox");
  await userEvent.type(input, "hello");
  const button = screen.getByRole("button", { name: "전송" });
  let finish!: () => void;
  requests.mockImplementation((command) =>
    command === "send_message"
      ? new Promise((resolve) => {
          finish = () => resolve(undefined);
        })
      : Promise.resolve(ready),
  );
  await userEvent.dblClick(button);
  expect(
    requests.mock.calls.filter(([command]) => command === "send_message"),
  ).toHaveLength(1);
  const turn = {
    id: "turn-1",
    message: "hello",
    response: "Hi",
    stopReason: null,
  };
  receive({ ...ready, status: "running", turns: [turn] });
  finish();
  expect(await screen.findByText("Hi")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "전송" })).toBeNull();
  expect(screen.getByRole("button", { name: "현재 작업 중단" })).toBe(button);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  receive({
    ...ready,
    turns: [{ ...turn, response: "Hi there", stopReason: "end_turn" }],
  });
  expect(await screen.findByText("Hi there")).toBeTruthy();
  expect(screen.getByText("완료")).toBeTruthy();
  await userEvent.type(input, "next");
  expect((button as HTMLButtonElement).disabled).toBe(false);
});

it("queues input above the composer and preserves it after stopping until deleted", async () => {
  const active = {
    id: "queue",
    title: "Queue",
    workingFolder: "/project",
    agentId: "codex",
    status: "running",
    turns: [
      { id: "turn", message: "first", response: "Working", stopReason: null },
    ],
    permissions: [],
    queuedMessages: [],
  };
  requests.mockResolvedValue(active);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  const queued = {
    ...active,
    queuedMessages: [
      { id: "q1", text: "next instruction with details" },
      { id: "q2", text: "last instruction" },
    ],
  };
  requests.mockResolvedValue(queued);
  await userEvent.type(
    screen.getByRole("textbox"),
    "next instruction with details{Enter}",
  );
  expect(invoke).toHaveBeenCalledWith("send_message", {
    id: "queue",
    input: { text: "next instruction with details", attachments: [] },
  });
  const queue = await screen.findByRole("list", { name: "대기 메시지" });
  expect(
    queue.compareDocumentPosition(screen.getByRole("textbox")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByText("next instruction with details")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "next instruction with details" }),
  ).toBeNull();
  receive(structuredClone(queued));
  expect(screen.getByText("next instruction with details")).toBeTruthy();
  requests.mockResolvedValue({
    ...queued,
    status: "sessionReady",
  });
  await userEvent.click(screen.getByRole("button", { name: "현재 작업 중단" }));
  expect(
    screen.getAllByRole("button", { name: /대기 메시지 삭제/ }),
  ).toHaveLength(2);
  requests.mockResolvedValue({
    ...queued,
    status: "sessionReady",
    queuedMessages: [queued.queuedMessages[1]],
  });
  await userEvent.click(
    screen.getAllByRole("button", { name: /대기 메시지 삭제/ })[0],
  );
  expect(invoke).toHaveBeenCalledWith("delete_queued_message", {
    id: "queue",
    message: "q1",
  });
  expect(screen.queryByText("next instruction with details")).toBeNull();
});

it("keeps the message on send failure and displays permission cancellation", async () => {
  const ready = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    turns: [],
  };
  requests.mockImplementation(async (command) => {
    if (command === "send_message")
      throw { message: "응답이 완료된 연결된 스레드에서 전송해주세요." };
    return ready;
  });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await userEvent.type(screen.getByRole("textbox"), "keep this");
  await userEvent.click(screen.getByRole("button", { name: "전송" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "응답이 완료된",
  );
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "keep this",
  );
  receive({
    ...ready,
    notice: "승인 UI가 아직 지원되지 않아 도구 실행 요청을 취소했습니다.",
  });
  expect(screen.getByText(/도구 실행 요청을 취소/)).toBeTruthy();
});

it("ignores updates after unmount and unsubscribes even when registration finishes late", async () => {
  const ready = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    turns: [],
  };
  let register!: (token: string) => void;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([]);
    if (command === "subscribe_thread_list") return Promise.resolve("list");
    if (command === "prepared_agents")
      return Promise.resolve([{ id: "codex", name: "Codex" }]);
    if (command === "subscribe_thread") {
      receiveUpdate = (args as { channel: { onmessage: typeof receiveUpdate } })
        .channel.onmessage;
      return new Promise((resolve) => {
        register = resolve;
      });
    }
    return Promise.resolve(ready);
  });
  const view = render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  view.unmount();
  register("late-subscription");
  await Promise.resolve();
  receive({ ...ready, notice: "should not appear" });
  expect(screen.queryByText("should not appear")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("unsubscribe_thread", {
    subscription: "late-subscription",
  });
});

it("appends ordered text deltas and rejects updates for another thread", async () => {
  const ready = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "running",
    turns: [{ id: "turn-1", message: "hello", response: "", stopReason: null }],
  };
  requests.mockResolvedValue(ready);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  const delta = {
    kind: "textDelta",
    threadId: "draft-1",
    turnId: "turn-1",
    text: "Hello",
  };
  receiveUpdate(delta);
  receiveUpdate({
    ...delta,
    threadId: "other",
    text: "wrong",
  });
  receiveUpdate({ ...delta, text: " world" });
  expect(await screen.findByText("Hello world")).toBeTruthy();
  expect(screen.queryByText(/wrong/)).toBeNull();
});

it("offers manual reconnection only after five automatic retries", async () => {
  const ready = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    turns: [],
  };
  requests.mockResolvedValue(ready);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await screen.findByRole("textbox");
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "subscribe_thread"
      ? Promise.reject(new Error("registration failed"))
      : (original?.(command, args) ?? Promise.resolve()),
  );
  vi.useFakeTimers();

  receiveUpdate({
    kind: "textDelta",
    threadId: "draft-1",
    turnId: "unknown",
    text: "ignored",
  });

  expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  for (let attempt = 0; attempt < 5; attempt++)
    await vi.advanceTimersByTimeAsync(5_000);
  expect(screen.getByRole("button", { name: "다시 연결" })).toBeTruthy();
});

it("does not disable the new thread when old subscription cleanup fails", async () => {
  const ready = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    turns: [],
  };
  requests
    .mockResolvedValueOnce(ready)
    .mockResolvedValueOnce({ ...ready, id: "draft-2" });
  const original = vi.mocked(invoke).getMockImplementation();
  if (!original) throw new Error("missing invocation fixture");
  let rejectCleanup!: (reason: Error) => void;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "unsubscribe_thread")
      return new Promise((_resolve, reject) => {
        rejectCleanup = reject;
      });
    return original(command, args);
  });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await userEvent.click(screen.getByRole("button", { name: "새 채팅" }));
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  rejectCleanup(new Error("old channel closed"));
  await userEvent.type(screen.getByRole("textbox"), "next");
  expect(
    (screen.getByRole("button", { name: "전송" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("opens agent management when creating a thread without an installed agent", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "prepared_agents") return [];
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return [
        {
          id: "codex",
          name: "Codex",
          installed: false,
          availableVersion: "1.12.0",
          distribution: {
            kind: "npm",
            package: "@agentclientprotocol/codex-acp@1.12.0",
          },
          authentication: {
            connected: false,
            authenticated: false,
            methods: [],
          },
        },
      ];
  });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(await screen.findByRole("heading", { name: "에이전트" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Codex 설치" })).toBeTruthy();
});

it("creates in the original folder after installing from project setup", async () => {
  let installed = false;
  const saved = {
    id: "saved",
    title: "Saved task",
    workingFolder: "/work/original",
    agentId: "missing",
    status: "disconnected",
    turns: [],
    permissions: [],
    queuedMessages: [],
  };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "prepared_agents")
      return installed ? [{ id: "new-provider", name: "New Provider" }] : [];
    if (command === "list_threads") return [saved];
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return [
        {
          id: "new-provider",
          name: "New Provider",
          installed,
          installedVersion: installed ? "1.0.0" : null,
          availableVersion: "1.0.0",
          distribution: { kind: "npm", package: "@fixture/agent@1.0.0" },
          authentication: {
            connected: false,
            authenticated: false,
            methods: [],
          },
        },
      ];
    if (command === "install_agent") {
      installed = true;
      return;
    }
    if (command === "create_thread") {
      const created = {
        ...saved,
        id: "new",
        title: "새 스레드",
        agentId: "new-provider",
      };
      pendingSnapshots.set(created.id, created);
      return created.id;
    }
    if (command === "connect_thread") {
      queueMicrotask(() =>
        receive({
          ...saved,
          id: "new",
          title: "새 스레드",
          agentId: "new-provider",
          status: "sessionReady",
        }),
      );
      return;
    }
    return original?.(command, args);
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "original에 새 스레드" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "New Provider 설치" }),
  );
  await screen.findByText("설치됨");
  expect(invoke).not.toHaveBeenCalledWith("create_thread", expect.anything());
  await userEvent.click(
    screen.getByRole("button", { name: "original에 새 스레드" }),
  );
  await screen.findByRole("textbox");
  expect(invoke).toHaveBeenCalledWith("create_thread", {
    folder: "/work/original",
    agentId: "new-provider",
  });
  expect(invoke).not.toHaveBeenCalledWith(
    "select_working_folder",
    expect.anything(),
  );
});

it("keeps streaming and the fixed thread while management is open", async () => {
  const ready = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "running",
    turns: [
      { id: "turn-1", message: "hello", response: "Hi", stopReason: null },
    ],
  };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return Promise.resolve([]);
    return original?.(command, args) ?? Promise.resolve();
  });
  requests.mockResolvedValue(ready);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await openAgentManagement();
  receiveUpdate({
    kind: "textDelta",
    threadId: "draft-1",
    turnId: "turn-1",
    text: " there",
  });
  await userEvent.click(
    screen.getByRole("button", { name: /^새 스레드.*실행 중$/ }),
  );
  expect(await screen.findByText("Hi there")).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith(
    "unsubscribe_thread",
    expect.anything(),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "subscribe_thread"),
  ).toHaveLength(1);
});

it("retries a failed install and offers the installed agent without restarting", async () => {
  let installed = false;
  let attempts = 0;
  let finishInstall: (() => void) | undefined;
  const agent = () => ({
    id: "new-provider",
    name: "New Provider",
    installed,
    installedVersion: installed ? "1.12.0" : null,
    availableVersion: "1.12.0",
    distribution: {
      kind: "npm",
      package: "@fixture/new-provider@1.12.0",
    },
    authentication: { connected: false, authenticated: false, methods: [] },
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_threads") return [];
    if (command === "subscribe_thread_list") return "list";
    if (command === "prepared_agents")
      return installed ? [{ id: "new-provider", name: "New Provider" }] : [];
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return [agent()];
    if (command === "install_agent") {
      attempts++;
      if (attempts === 1) throw "설치 실패. 다시 시도해주세요.";
      await new Promise<void>((resolve) => {
        finishInstall = () => {
          installed = true;
          resolve();
        };
      });
    }
    if (command === "select_working_folder") {
      expect(args).toEqual({
        agentId: "new-provider",
        dialogTitle: "작업 폴더 선택",
      });
      return null;
    }
  });
  render(() => <App />);
  await openAgentManagement();
  await userEvent.click(
    await screen.findByRole("button", { name: "New Provider 설치" }),
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "설치 실패. 다시 시도해주세요.",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "New Provider 설치" }),
  );
  expect(
    await screen.findByRole("button", { name: "New Provider 설치 중" }),
  ).toHaveProperty("disabled", true);
  finishInstall?.();
  expect(await screen.findByText("설치됨")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "새 채팅" }));
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
    "new-provider",
  );
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(invoke).toHaveBeenCalledWith("select_working_folder", {
    agentId: "new-provider",
    dialogTitle: "작업 폴더 선택",
  });
});

it("shows simplified agent cards while keeping cached installations on automatic refresh failure", async () => {
  const agents = [
    {
      id: "new-provider",
      name: "New Provider",
      description: "From registry",
      installed: false,
      availableVersion: "1.0.0",
      distribution: { kind: "npm", package: "new-provider@1.0.0" },
      authentication: { methods: [] },
    },
    {
      id: "uv-provider",
      name: "UV Provider",
      installed: false,
      distribution: null,
      unavailableReason: "지원하지 않는 배포 형식입니다.",
      authentication: { methods: [] },
    },
    {
      id: "removed-provider",
      name: "Removed Provider",
      installed: true,
      installedVersion: "2.0.0",
      distribution: null,
      unavailableReason: "Registry에서 제공하지 않는 기존 설치입니다.",
      authentication: {
        methods: [
          { id: "arbitrary-auth", name: "External auth", supported: false },
        ],
      },
    },
  ];
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_threads") return [];
    if (command === "subscribe_thread_list") return "list";
    if (command === "prepared_agents") return [];
    if (command === "refresh_agent_catalog") throw "Registry 갱신 실패";
    if (command === "agent_catalog") return agents;
  });
  render(() => <App />);
  await openAgentManagement();
  expect(
    await screen.findByRole("button", { name: "New Provider 설치" }),
  ).toHaveProperty("disabled", false);
  expect(screen.getByText("From registry")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "UV Provider 설치" }),
  ).toHaveProperty("disabled", true);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Registry 갱신 실패",
  );
  expect(screen.getByText("설치됨")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Removed Provider 삭제" }),
  ).toBeTruthy();
  for (const removed of [
    "공식 ACP Registry",
    "목록 새로고침",
    "에이전트를 설치하고 로그인한 뒤 작업 폴더에서 스레드를 시작하세요.",
    "npm · new-provider@1.0.0",
    "지원하지 않는 배포 형식입니다.",
    "External auth · 미지원 인증",
    "ACP 연결",
    "인증",
    "스레드 실행",
    "설치되지 않음",
  ]) {
    expect(screen.queryByText(removed)).toBeNull();
  }
  expect(invoke).toHaveBeenCalledWith("refresh_agent_catalog");
  const search = screen.getByRole("searchbox", {
    name: "에이전트 이름 검색",
  });
  await userEvent.type(search, "uv");
  expect(screen.getByRole("heading", { name: "UV Provider" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "New Provider" })).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Removed Provider" }),
  ).toBeNull();
  await userEvent.clear(search);
  await userEvent.type(search, "missing");
  expect(screen.getByRole("status")).toHaveProperty(
    "textContent",
    "검색 결과가 없습니다.",
  );
});

it("shows only confirmed account fields and capability-gated logout actions", async () => {
  const authentication = (
    authenticated: boolean,
    logoutSupported: boolean,
    email: string | null,
    plan: string | null,
  ) => ({
    connected: authenticated,
    authenticated,
    required: false,
    logoutSupported,
    email,
    plan,
    methods: [],
  });
  const agents = [
    {
      id: "complete",
      name: "Complete",
      authentication: authentication(true, true, "complete@example.com", "Pro"),
    },
    {
      id: "email-only",
      name: "Email only",
      authentication: authentication(true, true, "email@example.com", null),
    },
    {
      id: "plan-only",
      name: "Plan only",
      authentication: authentication(true, false, null, "Team"),
    },
    {
      id: "logout-only",
      name: "Logout only",
      authentication: authentication(true, true, null, null),
    },
    {
      id: "unverified",
      name: "Unverified",
      authentication: authentication(
        false,
        true,
        "hidden@example.com",
        "Enterprise",
      ),
    },
  ].map((agent) => ({
    ...agent,
    installed: true,
    description: "Fixture agent",
    accountLabel: "Never render this",
    organization: "Hidden organization",
  }));
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "prepared_agents") return [];
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return agents;
  });

  render(() => <App />);
  await openAgentManagement();

  expect(await screen.findByText("complete@example.com")).toBeTruthy();
  expect(screen.getByText("email@example.com")).toBeTruthy();
  expect(screen.getByText("Pro")).toBeTruthy();
  expect(screen.getByText("Team")).toBeTruthy();
  expect(screen.queryByText("hidden@example.com")).toBeNull();
  expect(screen.queryByText("Enterprise")).toBeNull();
  expect(screen.queryByText("Never render this")).toBeNull();
  expect(screen.queryByText("Hidden organization")).toBeNull();
  for (const name of ["Complete", "Email only", "Logout only"]) {
    expect(
      screen.getByRole("button", { name: `${name} 로그아웃` }),
    ).toBeTruthy();
  }
  for (const name of ["Plan only", "Unverified"]) {
    expect(
      screen.queryByRole("button", { name: `${name} 로그아웃` }),
    ).toBeNull();
  }
});

it("confirms logout, blocks duplicates, preserves failures, and clears only after success", async () => {
  const account = {
    connected: true,
    authenticated: true,
    required: false,
    logoutSupported: true,
    email: "user@example.com",
    plan: "Pro",
    methods: [],
  };
  let authenticated = true;
  let attempts = 0;
  const first = deferred<void>();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_threads") return [];
    if (command === "subscribe_thread_list") return "list";
    if (command === "prepared_agents") return [];
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return [
        {
          id: "codex",
          name: "Codex",
          installed: true,
          description: "Fixture agent",
          authentication: authenticated
            ? account
            : { ...account, authenticated: false, email: null, plan: null },
        },
      ];
    if (command === "logout_agent") {
      expect(args).toEqual({ id: "codex" });
      attempts++;
      if (attempts === 1) return first.promise;
      authenticated = false;
      return;
    }
  });

  render(() => <App />);
  await openAgentManagement();
  await userEvent.click(
    await screen.findByRole("button", { name: "Codex 로그아웃" }),
  );
  expect(screen.getByRole("alertdialog").textContent).toContain("Codex");
  await userEvent.click(screen.getByRole("button", { name: "취소" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(attempts).toBe(0);

  await userEvent.click(
    await screen.findByRole("button", { name: "Codex 로그아웃" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "로그아웃 확인" }));
  expect(
    await screen.findByRole("button", { name: "Codex 로그아웃 중" }),
  ).toHaveProperty("disabled", true);
  expect(attempts).toBe(1);
  first.reject("로그아웃 실패");
  expect((await screen.findByRole("alert")).textContent).toContain(
    "로그아웃 실패",
  );
  expect(screen.getByText("user@example.com")).toBeTruthy();
  expect(screen.getByText("Pro")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Codex 로그아웃" }));
  await userEvent.click(screen.getByRole("button", { name: "로그아웃 확인" }));
  await waitFor(() => {
    expect(screen.queryByText("user@example.com")).toBeNull();
    expect(screen.queryByRole("button", { name: "Codex 로그아웃" })).toBeNull();
  });
  expect(attempts).toBe(2);
});

it("keeps an existing thread after logout and follows a later authentication-required update", async () => {
  const ready = {
    id: "logout-thread",
    title: "Existing thread",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    authentication: "authenticated",
    failure: null,
    turns: [
      {
        id: "turn-1",
        message: "Question",
        response: "Preserved response",
        stopReason: "end_turn",
      },
    ],
    permissions: [],
    queuedMessages: [],
  };
  requests.mockResolvedValue(ready);
  let authenticated = true;
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return [
        {
          id: "codex",
          name: "Codex",
          installed: true,
          authentication: {
            connected: authenticated,
            authenticated,
            required: false,
            logoutSupported: authenticated,
            email: authenticated ? "thread@example.com" : null,
            plan: null,
            methods: [],
          },
        },
      ];
    if (command === "logout_agent") {
      authenticated = false;
      return;
    }
    if (command === "authenticate_agent") {
      expect(args).toEqual({ id: "codex", method: null });
      return {
        connected: true,
        authenticated: false,
        required: true,
        methods: [
          {
            id: "chat-gpt",
            name: "ChatGPT",
            description: null,
            terminal: false,
            supported: true,
          },
        ],
      };
    }
    return original?.(command, args);
  });

  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(await screen.findByText("Preserved response")).toBeTruthy();
  await openAgentManagement();
  await userEvent.click(
    await screen.findByRole("button", { name: "Codex 로그아웃" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "로그아웃 확인" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Existing thread" }),
  );
  expect(screen.getByText("Preserved response")).toBeTruthy();
  expect(screen.getByRole("textbox")).toHaveProperty("disabled", false);

  receive({
    ...ready,
    status: "failed",
    authentication: "required",
    failure: "authenticationRequired",
  });

  expect(await screen.findByRole("button", { name: "ChatGPT" })).toBeTruthy();
  expect(screen.getByText("Preserved response")).toBeTruthy();
});

it("confirms uninstall, supports cancel and retry, and removes the agent from new thread choices", async () => {
  let installed = true;
  let attempts = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_threads") return [];
    if (command === "subscribe_thread_list") return "list";
    if (command === "prepared_agents")
      return installed ? [{ id: "new-provider", name: "New Provider" }] : [];
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return [
        {
          id: "new-provider",
          name: "New Provider",
          installed,
          installedVersion: installed ? "1.0.0" : null,
          distribution: { kind: "npm", package: "new-provider@1" },
          authentication: { methods: [] },
        },
      ];
    if (command === "uninstall_agent") {
      expect(args).toEqual({ id: "new-provider" });
      if (++attempts === 1) throw "삭제 실패. 다시 시도해주세요.";
      installed = false;
      return;
    }
  });
  render(() => <App />);
  await openAgentManagement();
  await userEvent.click(
    await screen.findByRole("button", { name: "New Provider 삭제" }),
  );
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(attempts).toBe(0);
  await userEvent.click(
    await screen.findByRole("button", { name: "New Provider 삭제" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "삭제 확인" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "삭제 실패. 다시 시도해주세요.",
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "New Provider 삭제" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "삭제 확인" }));
  expect(
    await screen.findByRole("button", { name: "New Provider 설치" }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "새 채팅" }));
  expect(screen.queryByRole("option", { name: "New Provider" })).toBeNull();
});

it("keeps thread content after agent removal and offers setup and explicit retry", async () => {
  const draft = {
    id: "removed-chat",
    workingFolder: "/Users/test/project",
    agentId: "codex",
    status: "disconnected",
  };
  requests
    .mockResolvedValueOnce(draft)
    .mockResolvedValueOnce({ ...draft, status: "connecting" });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await screen.findByText("에이전트에 연결 중…");
  receive({
    ...draft,
    status: "failed",
    failure: "agentRemoved",
    authentication: "unknown",
    turns: [
      {
        id: "turn",
        message: "기존 질문",
        response: "삭제 전 응답",
        stopReason: "cancelled",
      },
    ],
  });
  expect(await screen.findByText("삭제 전 응답")).toBeTruthy();
  expect(screen.getByText(/에이전트를 설치한 뒤/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "다시 연결" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "설치·인증 관리 열기" }),
  ).toBeTruthy();
  expect(screen.getByRole("textbox")).toHaveProperty("disabled", true);
});

it("replaces the composer with agent choices and restores the draft after one decision", async () => {
  const ready = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    turns: [],
    permissions: [],
  };
  requests.mockResolvedValue(ready);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await userEvent.type(screen.getByRole("textbox"), "keep this draft");
  const turn = {
    id: "turn-1",
    message: "start",
    response: "",
    stopReason: null,
  };
  const permission = {
    id: "permission-1",
    title: "Write fixture.txt",
    details: "Only fixture.txt",
    options: [
      { id: "deny-927", name: "Do not write" },
      { id: "allow-482", name: "Write once" },
    ],
  };
  receive({
    ...ready,
    status: "waitingForApproval",
    turns: [turn],
    permissions: [permission],
  });
  const approval = await screen.findByRole("region", { name: "승인 요청" });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(approval.textContent).toContain("Write fixture.txt");
  expect(approval.textContent).toContain("/project");
  const choices = Array.from(approval.querySelectorAll("button")).map(
    (button) => button.textContent,
  );
  expect(choices).toEqual(["Do not write", "Write once"]);
  let resolve!: (value: unknown) => void;
  requests.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await userEvent.dblClick(screen.getByRole("button", { name: "Write once" }));
  expect(invoke).toHaveBeenCalledWith("answer_permission", {
    id: "draft-1",
    request: "permission-1",
    option: "allow-482",
  });
  expect(
    requests.mock.calls.filter(([command]) => command === "answer_permission"),
  ).toHaveLength(1);
  resolve({ ...ready, status: "running", turns: [turn] });
  expect(await screen.findByRole("textbox")).toHaveProperty(
    "value",
    "keep this draft",
  );
  expect(screen.queryByRole("region", { name: "승인 요청" })).toBeNull();
});

it.each(["running", "waitingForApproval"])(
  "can stop a %s turn and ignores a late thread",
  async (status) => {
    const turn = {
      id: "turn-1",
      message: "start",
      response: "",
      stopReason: null,
    };
    const waiting = {
      id: "draft-1",
      workingFolder: "/project",
      agentId: "codex",
      status,
      turns: [turn],
      permissions:
        status === "waitingForApproval"
          ? [
              {
                id: "p1",
                title: "Run command",
                details: "echo test",
                options: [{ id: "yes-42", name: "Run once" }],
              },
            ]
          : [],
    };
    requests.mockResolvedValue(waiting);
    render(() => <App />);
    await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
    requests.mockResolvedValue({
      ...waiting,
      status: "cancelling",
      permissions: [],
    });
    await userEvent.click(
      screen.getByRole("button", { name: "현재 작업 중단" }),
    );
    expect(invoke).toHaveBeenCalledWith("cancel_turn", {
      id: "draft-1",
      turn: "turn-1",
    });
    expect(
      screen.getByRole("button", { name: "현재 작업 중단" }),
    ).toHaveProperty("disabled", true);
    receive({
      ...waiting,
      status: "sessionReady",
      permissions: [],
      turns: [{ ...turn, stopReason: "cancelled" }],
    });
    expect(await screen.findByText("취소됨")).toBeTruthy();
    await userEvent.type(screen.getByRole("textbox"), "continue");
    expect(screen.getByRole("button", { name: "전송" })).toHaveProperty(
      "disabled",
      false,
    );
  },
);
