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

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
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

function getNewThreadButton() {
  const button = screen
    .getAllByRole("button", { name: "새 스레드" })
    .find((element) => element.dataset.sidebar === "menu-button");
  if (!button) throw new Error("New thread button not found");
  return button;
}

async function selectNewThreadAgent(name: string) {
  const selector = screen.getByRole("button", { name: /^새 스레드 에이전트/ });
  await waitFor(() => expect(selector).toHaveProperty("disabled", false));
  await userEvent.click(selector);
  await userEvent.click(await screen.findByRole("option", { name }));
}

async function startNewThreadWithAgent(name = "Codex") {
  await selectNewThreadAgent(name);
  await userEvent.click(screen.getByRole("button", { name: "스레드 시작" }));
}

function getSidebarThreadButton(name: string) {
  const button = screen
    .getAllByRole("button", { name })
    .find((element) => element.dataset.sidebar === "menu-sub-button");
  if (!button) throw new Error(`Thread button not found: ${name}`);
  return button;
}

const receive = (thread: Record<string, unknown>) =>
  receiveUpdate({ kind: "thread", thread });
function receiveFailure(thread: Record<string, unknown>) {
  receive(thread);
  if (thread.failure || thread.notice) {
    receiveUpdate({
      kind: "patch",
      thread,
      turnUpdates: [],
      errors: [
        {
          id: crypto.randomUUID(),
          failure: thread.failure,
          message: thread.notice,
        },
      ],
    });
  }
}
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
          website: "https://example.com/available",
          repository: "https://github.com/example/available",
        },
        {
          id: "broken",
          name: "Broken",
          icon: "https://cdn.agentclientprotocol.com/broken.svg",
          website: "javascript:alert('no')",
          repository: "https://github.com/example/broken",
        },
        {
          id: "missing",
          name: "Missing",
          icon: null,
          repository: "https://github.com/example/missing",
        },
      ].map((agent) => ({ ...agent, authentication: { methods: [] } }));
  });
  try {
    render(() => <App />);
    await openAgentManagement();
    await screen.findByRole("heading", { name: "Available" });
    const website = screen.getByRole("link", {
      name: "Available 관련 링크 열기",
    });
    expect(website.querySelector(".lucide-external-link")).not.toBeNull();
    expect(
      screen.queryByRole("link", { name: "Broken 관련 링크 열기" }),
    ).toBeNull();
    await userEvent.click(website);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/available");
    await userEvent.click(
      screen.getByRole("link", { name: "Missing 관련 링크 열기" }),
    );
    expect(openUrl).toHaveBeenLastCalledWith(
      "https://github.com/example/missing",
    );
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
const folderSelection = vi.fn();
beforeEach(() => {
  localStorage.clear();
  pendingSnapshots = new Map();
  layoutWidth = 800;
  resizeObservers = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverFixture);
  vi.resetAllMocks();
  folderSelection.mockResolvedValue("/project");
  openUrl.mockResolvedValue(undefined);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    () => layoutWidth,
  );
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "subscribe_thread_list")
      return Promise.resolve("list-subscription");
    if (command === "list_threads") return Promise.resolve([]);
    if (command === "select_working_folder") return folderSelection();
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
      command === "create_thread" &&
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
        queueMicrotask(() => receiveFailure(result as Record<string, unknown>));
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
  expect(await screen.findByRole("heading", { name: "일반" })).toBeTruthy();
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

  await userEvent.click(
    screen.getByRole("button", { name: "언어 시스템 설정" }),
  );
  await userEvent.click(screen.getByRole("option", { name: "English" }));
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

it("starts on new thread and preserves a thread draft across that navigation", async () => {
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
    await screen.findByRole("heading", { name: "무엇을 만들고 싶으세요?" }),
  ).toBeTruthy();
  expect(getNewThreadButton().getAttribute("aria-current")).toBe("page");
  await userEvent.click(
    await screen.findByRole("button", { name: saved.title }),
  );
  await userEvent.type(screen.getByRole("textbox"), "preserved draft");
  await userEvent.click(getNewThreadButton());
  expect(
    screen.getByRole("heading", { name: "무엇을 만들고 싶으세요?" }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: saved.title }));
  expect(await screen.findByRole("textbox")).toHaveProperty(
    "value",
    "preserved draft",
  );
});

it("shows the thread agent icon beside both titles and keeps the composer free of agent identity", async () => {
  const images: HTMLImageElement[] = [];
  vi.spyOn(window, "Image").mockImplementation(function ImageFixture() {
    const image = document.createElement("img");
    images.push(image);
    return image;
  });
  const saved = {
    id: "agent-icon-thread",
    title: "Agent icon thread",
    workingFolder: "/work/project",
    agentId: "codex-acp",
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
  const sidebarTitle = await screen.findByRole("button", {
    name: saved.title,
  });
  await userEvent.click(sidebarTitle);
  await screen.findByRole("heading", {
    name: saved.title,
  });
  await waitFor(() => expect(images.length).toBeGreaterThanOrEqual(2));
  for (const image of images) fireEvent.load(image);
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: saved.title }).querySelector("img")
        ?.src,
    ).toContain("data:image/svg+xml");
    expect(
      screen.getByRole("heading", { name: saved.title }).querySelector("img")
        ?.src,
    ).toContain("data:image/svg+xml");
  });
  expect(
    screen.getByRole("textbox").closest("form")?.textContent,
  ).not.toContain("Codex");
});

it("updates sidebar and header titles through subscriptions and shows the default after clearing", async () => {
  const saved = {
    id: "title-thread",
    title: "Provisional title",
    workingFolder: "/work/project",
    agentId: "codex",
    status: "sessionReady",
    authentication: "authenticated",
    turns: [],
    permissions: [],
    queuedMessages: [],
  };
  const other = { ...saved, id: "other", title: "Other thread" };
  let receiveList!: (entries: unknown[]) => void;
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([saved, other]);
    if (command === "subscribe_thread_list") {
      receiveList = (args as { channel: { onmessage: typeof receiveList } })
        .channel.onmessage;
      return Promise.resolve("list");
    }
    if (command === "subscribe_thread")
      return subscribeWith(
        args,
        (args as { id: string }).id === saved.id ? saved : other,
      );
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: saved.title }),
  );
  await screen.findByRole("heading", { name: saved.title });

  const title = "에이전트 제목 ".repeat(20);
  const renamed = { ...saved, title };
  receiveUpdate({
    kind: "patch",
    thread: renamed,
    turnUpdates: [],
    errors: [],
  });
  receiveList([renamed, other]);
  expect(
    await screen.findByRole("heading", { name: title.trim() }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(getSidebarThreadButton(title.trim())).toBeTruthy(),
  );

  const cleared = { ...saved, title: "" };
  receiveUpdate({
    kind: "patch",
    thread: cleared,
    turnUpdates: [],
    errors: [],
  });
  receiveList([cleared, other]);
  expect(
    await screen.findByRole("heading", { name: "새 스레드" }),
  ).toBeTruthy();
  await waitFor(() => expect(getSidebarThreadButton("새 스레드")).toBeTruthy());

  const oldReceive = receiveUpdate;
  await userEvent.click(getSidebarThreadButton(other.title));
  await screen.findByRole("heading", { name: other.title });
  oldReceive({ kind: "patch", thread: renamed, turnUpdates: [], errors: [] });
  expect(screen.getByRole("heading", { name: other.title })).toBeTruthy();
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
      name: /^First project task.*승인 요청$/,
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
  expect(screen.getByRole("button", { name: "project" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /^새 스레드 에이전트/ }).textContent,
  ).toContain("에이전트 선택");
  expect(screen.getByRole("button", { name: "스레드 시작" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(invoke).not.toHaveBeenCalledWith("create_thread", expect.anything());
  expect(invoke).not.toHaveBeenCalledWith(
    "select_working_folder",
    expect.anything(),
  );
  await startNewThreadWithAgent();
  expect(invoke).toHaveBeenCalledWith("create_thread", {
    folder: "/work/project",
    agentId: "codex",
  });
  expect(invoke).toHaveBeenCalledWith("connect_thread", { id: "new" });
});

it.each(["light", "dark"])(
  "remembers new thread selections until app remount in %s theme",
  async (theme) => {
    localStorage.setItem("atte.theme", theme);
    const saved = {
      id: "saved",
      title: "Saved task",
      workingFolder: "/work/original",
      agentId: "codex",
      status: "disconnected",
      turns: [],
    };
    const original = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "list_threads") return Promise.resolve([saved]);
      if (command === "prepared_agents")
        return Promise.resolve([
          { id: "codex", name: "Codex" },
          { id: "fixture", name: "Fixture" },
        ]);
      return original?.(command, args) ?? Promise.resolve();
    });
    requests.mockResolvedValue({ ...saved, id: "created", agentId: "fixture" });
    render(() => <App />);
    expect(document.documentElement.dataset.theme).toBe(theme);
    await selectNewThreadAgent("Codex");
    await userEvent.click(
      await screen.findByRole("button", { name: "original에 새 스레드" }),
    );
    expect(screen.getByRole("button", { name: "original" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^새 스레드 에이전트/ }).textContent,
    ).toContain("Codex");
    const start = screen.getByRole("button", { name: "스레드 시작" });
    expect(start).toHaveProperty("disabled", false);
    expect(invoke).not.toHaveBeenCalledWith("create_thread", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(
      "connect_thread",
      expect.anything(),
    );
    await selectNewThreadAgent("Fixture");
    // The preselected project can still be changed before creation.
    await userEvent.click(screen.getByRole("button", { name: "original" }));
    expect(screen.getByRole("button", { name: "project" })).toBeTruthy();
    await userEvent.click(start);
    expect(invoke).toHaveBeenCalledWith("create_thread", {
      folder: "/project",
      agentId: "fixture",
    });
    await screen.findByRole("textbox");
    await userEvent.click(getNewThreadButton());
    expect(screen.getByRole("button", { name: "project" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^새 스레드 에이전트/ }).textContent,
    ).toContain("Fixture");
    expect(screen.getByRole("button", { name: "스레드 시작" })).toHaveProperty(
      "disabled",
      false,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "original에 새 스레드" }),
    );
    expect(screen.getByRole("button", { name: "original" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^새 스레드 에이전트/ }).textContent,
    ).toContain("Fixture");
    await userEvent.click(getNewThreadButton());
    expect(screen.getByRole("button", { name: "original" })).toBeTruthy();

    cleanup();
    render(() => <App />);
    expect(screen.getByRole("button", { name: "폴더 선택" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^새 스레드 에이전트/ }).textContent,
    ).toContain("에이전트 선택");
    expect(screen.getByRole("button", { name: "스레드 시작" })).toHaveProperty(
      "disabled",
      true,
    );
  },
);

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

  const reasoning = screen.getByRole("button", {
    name: "Reasoning effort Balanced",
  });
  expect(reasoning.getAttribute("title")).toBe(
    "Choose how deeply the agent reasons",
  );
  await userEvent.click(reasoning);
  expect(screen.getByText("Standard efforts")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(
    screen
      .getByRole("switch", { name: "Planning mode: 켜짐" })
      .getAttribute("title"),
  ).toBe("Plan before acting");

  expect(screen.queryByText("스레드 설정")).toBeNull();
  const sandbox = screen.getByRole("button", { name: "Sandbox Workspace" });
  expect(sandbox.getAttribute("title")).toBe("Limit file access");
  await userEvent.click(sandbox);
  expect(screen.getByText("Safe modes")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(
    screen.getByRole("switch", { name: "Notifications: 꺼짐" }),
  ).toBeTruthy();

  await userEvent.click(
    await screen.findByRole("button", { name: "Model Model A" }),
  );
  await userEvent.click(screen.getByRole("option", { name: "Model B" }));
  expect(invoke).toHaveBeenCalledWith("set_thread_configuration", {
    id: "configured",
    configId: "opaque-model",
    value: { type: "select", value: "model-b" },
  });
  expect(
    await screen.findByRole("button", { name: "Model Model B" }),
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
    expect(screen.queryByRole("button", { name: /^Model Model/ })).toBeNull(),
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
        responseParts: [{ kind: "text", id: "text-1", text: "working" }],
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

  await userEvent.click(screen.getByRole("button", { name: "Model Model A" }));
  await userEvent.click(screen.getByRole("option", { name: "Model B" }));
  expect(
    await screen.findByRole("button", { name: "Model Model B" }),
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
        toolCallId: "tool-1",
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
    screen.getByRole("button", { name: "Reasoning effort Low" }),
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
    await screen.findByRole("heading", { name: "무엇을 만들고 싶으세요?" }),
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
    await screen.findByRole("heading", { name: "무엇을 만들고 싶으세요?" }),
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
        receiveFailure({
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
  expect(
    (await screen.findByRole("status", { name: "스레드 오류" })).textContent,
  ).toContain("에이전트를 설치한 뒤");
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
  await screen.findByText("불러오는 중");
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
        responseParts: [{ kind: "text", id: "text-1", text: "과거 답변" }],
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
        receiveFailure({
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
      .getAllByRole("button", {
        name: new RegExp(`^${saved.title}`),
        hidden: true,
      })
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
  await startNewThreadWithAgent();
  await waitFor(() => {
    expect(
      getSidebarThreadButton("새 스레드").getAttribute("aria-current"),
    ).toBe("page");
  });
  expect(screen.getByText("불러오는 중")).toBeTruthy();
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
  folderSelection.mockResolvedValueOnce(null);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(
    screen.getByRole("heading", { name: "무엇을 만들고 싶으세요?" }),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("connect_thread", expect.anything());
});

it("shows folder errors and lets the user retry", async () => {
  folderSelection.mockRejectedValueOnce({
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

it("keeps the new thread page when another folder selection is cancelled", async () => {
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
    });
  folderSelection
    .mockResolvedValueOnce("/Users/test/project")
    .mockResolvedValueOnce(null);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await startNewThreadWithAgent();
  await screen.findByRole("textbox");
  await userEvent.click(getNewThreadButton());
  await userEvent.click(screen.getByRole("button", { name: "project" }));
  expect(
    screen.getByRole("heading", { name: "무엇을 만들고 싶으세요?" }),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("disables folder selection until the native dialog completes", async () => {
  let finish!: (value: null) => void;
  folderSelection.mockReturnValueOnce(
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

it("connects the fixed agent and waits for the first message without an authentication status notice", async () => {
  requests.mockImplementation(async (command) => {
    if (command === "create_thread")
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
  await startNewThreadWithAgent();
  expect(await screen.findByText("불러오는 중")).toBeTruthy();
  receive({
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    turns: [],
    authentication: "unknown",
  });
  expect(
    await screen.findByRole("heading", {
      name: "첫 메시지를 기다리고 있어요",
    }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  expect(
    screen.queryByText("인증 상태는 아직 확인되지 않았습니다."),
  ).toBeNull();
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
    if (command === "create_thread") return draft;
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
  await startNewThreadWithAgent();
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.queryByRole("status", { name: "스레드 오류" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
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

it("automatically blocks the thread with sign-in while preserving the composer", async () => {
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
  expect(threadButton.querySelector('[role="status"]')).toBeNull();
  expect(screen.queryByRole("status", { name: "연결 오류" })).toBeNull();
  await userEvent.click(threadButton);
  expect(
    await screen.findByRole("dialog", { name: "Codex 로그인" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(screen.getByRole("textbox", { hidden: true })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "전송", hidden: true }),
  ).toHaveProperty("disabled", true);
  expect(await screen.findByText("로그인 방법을 불러오는 중…")).toBeTruthy();
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
    "Continue in browser Use your existing account",
    "Continue in Terminal ",
  ]);
  expect(screen.getByText("Use your existing account")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Future protocol" })).toBeNull();
  expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  expect(screen.queryByRole("button", { name: "로그인 안내 열기" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "로그인 창 닫기" })).toBeNull();
});

function mockSignInThread() {
  const failed = {
    id: "dialog-thread",
    title: "Dialog work",
    agentId: "codex",
    workingFolder: "/project",
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
    permissions: [],
    queuedMessages: [],
  };
  const ready = {
    ...failed,
    status: "sessionReady",
    failure: null,
    authentication: "unknown",
  };
  const login = deferred<Record<string, unknown>>();
  const cancellation = deferred<void>();
  let methods = [
    {
      id: "terminal",
      name: "Terminal account",
      description: "Use your agent account",
      terminal: true,
      supported: true,
    },
  ];
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([ready]);
    if (command === "subscribe_thread") return subscribeWith(args, ready);
    if (command === "authenticate_agent")
      return (args as { method: string | null }).method
        ? login.promise
        : Promise.resolve({ methods });
    if (command === "cancel_agent_authentication") return cancellation.promise;
    if (command === "connect_thread") return Promise.resolve();
    return original?.(command, args) ?? Promise.resolve();
  });
  return {
    failed,
    requireSignIn: () => receive(failed),
    login,
    cancellation,
    emptyMethods: () => {
      methods = [];
    },
  };
}

it.each(["escape", "close", "outside"] as const)(
  "blocks %s dismissal while retaining sign-in progress and the draft",
  async (dismissal) => {
    const { login, cancellation, requireSignIn } = mockSignInThread();
    render(() => <App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Dialog work" }),
    );
    await userEvent.type(
      await screen.findByRole("textbox"),
      "keep after cancel",
    );
    requireSignIn();
    const method = await screen.findByRole("button", {
      name: "Terminal account Use your agent account",
    });
    method.focus();
    await userEvent.keyboard("{Enter}");
    expect(
      await screen.findByText("터미널에서 로그인을 완료하세요."),
    ).toBeTruthy();
    if (dismissal === "escape") await userEvent.keyboard("{Escape}");
    else if (dismissal === "close")
      expect(
        screen.queryByRole("button", { name: "로그인 창 닫기" }),
      ).toBeNull();
    else {
      fireEvent.pointerDown(document.body);
      fireEvent.pointerUp(document.body);
      fireEvent.click(document.body);
    }
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(
          ([command]) => command === "cancel_agent_authentication",
        ),
    ).toBe(false);
    expect(screen.getByRole("textbox", { hidden: true })).toHaveProperty(
      "value",
      "keep after cancel",
    );
    await userEvent.click(screen.getByRole("button", { name: "로그인 취소" }));
    expect(await screen.findByText("로그인을 취소하는 중…")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Terminal account/ }),
    ).toBeNull();
    cancellation.resolve();
    expect(
      await screen.findByRole("button", {
        name: "Terminal account Use your agent account",
      }),
    ).toBeTruthy();
    login.resolve({ authenticated: true });
    await Promise.resolve();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(
          ([command]) =>
            command === "connect_thread" || command === "send_message",
        ),
    ).toBe(false);
  },
);

it("shows login failure once in the dialog and retries discovery into an empty supported list", async () => {
  const { login, emptyMethods, requireSignIn } = mockSignInThread();
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Dialog work" }),
  );
  await userEvent.type(
    await screen.findByRole("textbox"),
    "keep after failure",
  );
  requireSignIn();
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Terminal account Use your agent account",
    }),
  );
  login.reject("Sign-in service unavailable");
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Sign-in service unavailable",
  );
  expect(screen.getAllByText("Sign-in service unavailable")).toHaveLength(1);
  emptyMethods();
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(
    await screen.findByText("지원되는 로그인 방법이 없습니다."),
  ).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("textbox", { hidden: true })).toHaveProperty(
    "value",
    "keep after failure",
  );
});

it("keeps successful login distinct from reconnect failure and retains recovery and the draft", async () => {
  const { failed, login, requireSignIn } = mockSignInThread();
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Dialog work" }),
  );
  await userEvent.type(
    await screen.findByRole("textbox"),
    "recover this draft",
  );
  requireSignIn();
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Terminal account Use your agent account",
    }),
  );
  login.resolve({ authenticated: true });
  expect(
    await screen.findByText("로그인 완료. 스레드를 다시 연결하는 중…"),
  ).toBeTruthy();
  receive({ ...failed, status: "connecting", failure: null });
  receive({
    ...failed,
    failure: "processExited",
    authentication: "authenticated",
  });
  expect(
    await screen.findByText("로그인 완료. 스레드를 다시 연결해주세요."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("textbox", { hidden: true })).toHaveProperty(
    "value",
    "recover this draft",
  );
  expect(screen.getByRole("button", { name: "다시 연결" })).toHaveProperty(
    "disabled",
    false,
  );
});

it("shows reconnect command failure without turning successful sign-in into a login failure", async () => {
  const { failed, login, requireSignIn } = mockSignInThread();
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "connect_thread"
      ? Promise.reject("Reconnect command unavailable")
      : (original?.(command, args) ?? Promise.resolve()),
  );
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Dialog work" }),
  );
  await userEvent.type(
    await screen.findByRole("textbox"),
    "keep after command failure",
  );
  requireSignIn();
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Terminal account Use your agent account",
    }),
  );
  login.resolve({ authenticated: true });
  expect(
    await screen.findByText("로그인 완료. 스레드를 다시 연결해주세요."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("textbox", { hidden: true })).toHaveProperty(
    "value",
    "keep after command failure",
  );
  await userEvent.click(screen.getByRole("button", { name: "다시 연결" }));
  expect(invoke).toHaveBeenCalledWith("reconnect_thread", { id: failed.id });
  receive({
    ...failed,
    status: "sessionReady",
    failure: null,
    authentication: "authenticated",
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByRole("textbox")).toHaveProperty(
    "value",
    "keep after command failure",
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("textbox")),
  );
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

  await userEvent.click(
    await screen.findByRole("button", { name: "Second private thread" }),
  );
  expect(await screen.findByRole("dialog")).toBeTruthy();
  await userEvent.click(getNewThreadButton());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await userEvent.click(
    screen.getByRole("button", { name: "Second private thread" }),
  );
  expect(await screen.findByRole("dialog")).toBeTruthy();
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
  expect(screen.getByText("로그인을 취소하는 중…")).toBeTruthy();
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
    if (command === "select_files")
      return Promise.resolve({
        attachments: [
          {
            id: "kept-file",
            kind: "linked",
            name: "notes.txt",
            path: "/project/notes.txt",
          },
        ],
        errors: [],
      });
    if (command === "connect_thread") return Promise.resolve();
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);

  const title = await screen.findByText("Private work");
  await userEvent.click(title.closest("button") as HTMLButtonElement);
  await userEvent.type(await screen.findByRole("textbox"), "keep this draft");
  await userEvent.click(screen.getByRole("button", { name: "첨부 추가" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "파일" }));
  expect(await screen.findByText("notes.txt")).toBeTruthy();
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
  expect(
    await screen.findByText("로그인 완료. 스레드를 다시 연결하는 중…"),
  ).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
  receive({ ...ready, queuedMessages: failed.queuedMessages });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByRole("textbox")).toHaveProperty(
    "value",
    "keep this draft",
  );
  expect(screen.getByText("wait for me")).toBeTruthy();
  expect(screen.getByText("notes.txt")).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("textbox")),
  );
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
  expect(await screen.findByText("불러오는 중")).toBeTruthy();
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
    if (command === "create_thread") return draft;
    if (command === "connect_thread")
      return { ...draft, status: "sessionReady" };
    return { ...draft, status: "failed", failure: "processExited" };
  });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await startNewThreadWithAgent();
  expect(
    await screen.findByRole("heading", {
      name: "첫 메시지를 기다리고 있어요",
    }),
  ).toBeTruthy();
  receiveFailure({
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "failed",
    failure: "processExited",
    turns: [],
  });
  expect(
    (await screen.findByRole("status", { name: "스레드 오류" })).textContent,
  ).toContain("프로세스가 종료");
  expect(screen.queryByRole("alert")).toBeNull();
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
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^새 스레드 에이전트/ }),
    ).toHaveProperty("disabled", false),
  );
  await userEvent.click(
    screen.getByRole("button", { name: /^새 스레드 에이전트/ }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "Fixture" }));
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await userEvent.click(screen.getByRole("button", { name: "스레드 시작" }));
  expect(invoke).toHaveBeenCalledWith("select_working_folder", {
    dialogTitle: "작업 폴더 선택",
  });
  expect(invoke).toHaveBeenCalledWith("connect_thread", {
    id: "draft-1",
  });
  await userEvent.click(getNewThreadButton());
  await userEvent.click(
    screen.getByRole("button", { name: /^새 스레드 에이전트/ }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "Codex" }));
  expect(
    screen.getByRole("button", { name: /^새 스레드 에이전트/ }).textContent,
  ).toContain("Codex");
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
  await startNewThreadWithAgent();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "폴더를 다시 선택해주세요",
  );
  await userEvent.click(screen.getByRole("button", { name: "스레드 메뉴" }));
  expect(
    screen
      .getByRole("menuitem", { name: "다시 연결" })
      .getAttribute("aria-disabled"),
  ).not.toBe("true");
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
  await startNewThreadWithAgent();
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
  await startNewThreadWithAgent();

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
  await startNewThreadWithAgent();

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
  await startNewThreadWithAgent();
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
    responseParts: [{ kind: "text", id: "text-1", text: "Hi" }],
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
    turns: [
      {
        ...turn,
        responseParts: [{ kind: "text", id: "text-1", text: "Hi there" }],
        stopReason: "end_turn",
      },
    ],
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
      {
        id: "turn",
        message: "first",
        responseParts: [{ kind: "text", id: "text-1", text: "Working" }],
        stopReason: null,
      },
    ],
    permissions: [],
    queuedMessages: [],
  };
  requests.mockResolvedValue(active);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await startNewThreadWithAgent();
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
  await startNewThreadWithAgent();
  await userEvent.type(screen.getByRole("textbox"), "keep this");
  await userEvent.click(screen.getByRole("button", { name: "전송" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "응답이 완료된",
  );
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "keep this",
  );
  receiveFailure({
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
    if (command === "select_working_folder") return Promise.resolve("/project");
    if (command === "create_thread") return Promise.resolve(ready.id);
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
  await startNewThreadWithAgent();
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
    turns: [
      { id: "turn-1", message: "hello", responseParts: [], stopReason: null },
    ],
  };
  requests.mockResolvedValue(ready);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await startNewThreadWithAgent();
  const delta = {
    kind: "textDelta",
    partId: "text-1",
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
  await startNewThreadWithAgent();
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
    partId: "text-1",
    threadId: "draft-1",
    turnId: "unknown",
    text: "ignored",
  });

  expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  for (let attempt = 0; attempt < 5; attempt++)
    await vi.advanceTimersByTimeAsync(5_000);
  vi.useRealTimers();
  await userEvent.click(screen.getByRole("button", { name: "스레드 메뉴" }));
  expect(
    screen
      .getByRole("menuitem", { name: "다시 연결" })
      .getAttribute("aria-disabled"),
  ).not.toBe("true");
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
  await startNewThreadWithAgent();
  await userEvent.click(getNewThreadButton());
  await userEvent.click(screen.getByRole("button", { name: "project" }));
  await startNewThreadWithAgent();
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
  await userEvent.click(
    await screen.findByRole("button", { name: "에이전트 관리" }),
  );
  expect(await screen.findByRole("heading", { name: "에이전트" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Codex 설치" })).toBeTruthy();
});

it("keeps project setup after installation until an agent is explicitly selected", async () => {
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
  expect(screen.getByRole("button", { name: "original" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "에이전트 관리" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "New Provider 설치" }),
  );
  await screen.findByText("설치됨");
  expect(invoke).not.toHaveBeenCalledWith("create_thread", expect.anything());
  await userEvent.click(
    screen.getByRole("button", { name: "original에 새 스레드" }),
  );
  expect(screen.getByRole("button", { name: "original" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "스레드 시작" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(invoke).not.toHaveBeenCalledWith("create_thread", expect.anything());
  await startNewThreadWithAgent("New Provider");
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
      {
        id: "turn-1",
        message: "hello",
        responseParts: [{ kind: "text", id: "text-1", text: "Hi" }],
        stopReason: null,
      },
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
  await startNewThreadWithAgent();
  await openAgentManagement();
  receiveUpdate({
    kind: "textDelta",
    partId: "text-1",
    threadId: "draft-1",
    turnId: "turn-1",
    text: " there",
  });
  await userEvent.click(getSidebarThreadButton("새 스레드"));
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
  await userEvent.click(getNewThreadButton());
  expect(
    screen.getByRole("button", { name: /^새 스레드 에이전트/ }).textContent,
  ).toContain("에이전트 선택");
  await selectNewThreadAgent("New Provider");
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(invoke).toHaveBeenCalledWith("select_working_folder", {
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
  expect(screen.queryByText("이메일:")).toBeNull();
  expect(screen.queryByText("요금제:")).toBeNull();
  expect(
    screen
      .getByText("complete@example.com")
      .closest("article")
      ?.querySelector(".lucide-dot"),
  ).not.toBeNull();
  expect(
    screen
      .getByText("email@example.com")
      .closest("article")
      ?.querySelector(".lucide-dot"),
  ).toBeNull();
  expect(screen.queryByText("hidden@example.com")).toBeNull();
  expect(screen.queryByText("Enterprise")).toBeNull();
  expect(screen.queryByText("Never render this")).toBeNull();
  expect(screen.queryByText("Hidden organization")).toBeNull();
  for (const name of ["Complete", "Email only", "Logout only"]) {
    expect(
      await screen.findByRole("button", { name: `${name} 로그아웃` }),
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
        responseParts: [
          { kind: "text", id: "text-1", text: "Preserved response" },
        ],
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
  await startNewThreadWithAgent();
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
  await userEvent.click(getNewThreadButton());
  expect(screen.queryByRole("option", { name: "New Provider" })).toBeNull();
});

it("keeps thread content after agent removal and offers setup and explicit retry", async () => {
  const draft = {
    id: "removed-thread",
    workingFolder: "/Users/test/project",
    agentId: "codex",
    status: "disconnected",
  };
  requests
    .mockResolvedValueOnce(draft)
    .mockResolvedValueOnce({ ...draft, status: "connecting" });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await startNewThreadWithAgent();
  await screen.findByText("불러오는 중");
  receiveFailure({
    ...draft,
    status: "failed",
    failure: "agentRemoved",
    authentication: "unknown",
    turns: [
      {
        id: "turn",
        message: "기존 질문",
        responseParts: [{ kind: "text", id: "text-1", text: "삭제 전 응답" }],
        stopReason: "cancelled",
      },
    ],
  });
  expect(await screen.findByText("삭제 전 응답")).toBeTruthy();
  expect(
    screen.getByRole("status", { name: "스레드 오류" }).textContent,
  ).toContain("에이전트를 설치한 뒤");
  await userEvent.click(screen.getByRole("button", { name: "스레드 메뉴" }));
  expect(
    screen
      .getByRole("menuitem", { name: "다시 연결" })
      .getAttribute("aria-disabled"),
  ).not.toBe("true");
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
  await startNewThreadWithAgent();
  await userEvent.type(screen.getByRole("textbox"), "keep this draft");
  const turn = {
    id: "turn-1",
    message: "start",
    responseParts: [],
    stopReason: null,
  };
  const permission = {
    id: "permission-1",
    toolCallId: "tool-1",
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
      responseParts: [],
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
    await startNewThreadWithAgent();
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

it("keeps folder selection local until starting with the currently selected agent", async () => {
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "prepared_agents"
      ? Promise.resolve([
          { id: "codex", name: "Codex" },
          { id: "fixture", name: "Fixture" },
        ])
      : (original?.(command, args) ?? Promise.resolve()),
  );
  folderSelection
    .mockResolvedValueOnce("/work/프로젝트")
    .mockResolvedValueOnce(null);
  requests.mockResolvedValue({
    id: "new-thread",
    workingFolder: "/work/프로젝트",
    agentId: "fixture",
    status: "disconnected",
    turns: [],
  });
  render(() => <App />);
  expect(screen.getByRole("button", { name: "스레드 시작" })).toHaveProperty(
    "disabled",
    true,
  );
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(screen.getByRole("button", { name: "프로젝트" })).toBeTruthy();
  expect(screen.queryByText("/work/프로젝트")).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("create_thread", expect.anything());
  expect(invoke).not.toHaveBeenCalledWith("connect_thread", expect.anything());
  await userEvent.click(screen.getByRole("button", { name: /프로젝트/ }));
  expect(screen.getByRole("button", { name: "프로젝트" })).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: /^새 스레드 에이전트/ }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "Fixture" }));
  await userEvent.click(screen.getByRole("button", { name: "스레드 시작" }));
  expect(invoke).toHaveBeenCalledWith("create_thread", {
    folder: "/work/프로젝트",
    agentId: "fixture",
  });
  await screen.findByRole("textbox");
});

it("retains the chosen folder after creation fails and allows retry", async () => {
  requests
    .mockRejectedValueOnce({
      code: "invalidWorkingFolder",
      message: "존재하는 작업 폴더를 선택해주세요.",
    })
    .mockResolvedValue({
      id: "retry-thread",
      workingFolder: "/project",
      agentId: "codex",
      status: "disconnected",
      turns: [],
    });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await startNewThreadWithAgent();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("button", { name: "project" })).toBeTruthy();
  expect(screen.queryByText("/project")).toBeNull();
  expect(screen.getByRole("button", { name: "스레드 시작" })).toHaveProperty(
    "disabled",
    false,
  );
  await startNewThreadWithAgent();
  await screen.findByRole("textbox");
  expect(folderSelection).toHaveBeenCalledTimes(1);
});

it("loads centrally during manual reconnection and restores history and the draft", async () => {
  const saved = {
    id: "manual-reconnect",
    title: "Reconnect preview",
    agentId: "codex",
    workingFolder: "/project",
    status: "sessionReady",
    sessionId: "remote-1",
    authentication: "authenticated",
    turns: [
      {
        id: "turn",
        message: "Previous question",
        responseParts: [
          { kind: "text", id: "text-1", text: "Previous answer" },
        ],
        stopReason: "end_turn",
      },
    ],
    permissions: [],
    queuedMessages: [],
  };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([saved]);
    if (command === "subscribe_thread") return subscribeWith(args, saved);
    if (command === "reconnect_thread") {
      queueMicrotask(() => receive({ ...saved, status: "connecting" }));
      return Promise.resolve();
    }
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: saved.title }),
  );
  await userEvent.type(screen.getByRole("textbox"), "preserve this draft");
  const menu = screen.getByRole("button", { name: "스레드 메뉴" });
  menu.focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.click(screen.getByRole("menuitem", { name: "다시 연결" }));
  expect(
    await screen.findByRole("heading", { name: "불러오는 중" }),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: "스레드 타임라인" })).toBeNull();
  await userEvent.click(menu);
  expect(
    screen
      .getByRole("menuitem", { name: "다시 연결" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  await userEvent.keyboard("{Escape}");
  receive({ ...saved, interrupted: true });
  expect(await screen.findByText("Previous answer")).toBeTruthy();
  expect(await screen.findByRole("textbox")).toHaveProperty(
    "value",
    "preserve this draft",
  );
  expect(screen.queryByText(/이전 작업이 중단/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("reconnect_thread", { id: saved.id });
});

it("shows first-message waiting after a history-free resumption without its notice", async () => {
  const resumed = {
    id: "resumed",
    title: "Resumed thread",
    agentId: "codex",
    workingFolder: "/project",
    status: "sessionReady",
    sessionId: "remote-1",
    turns: [],
    interrupted: true,
    notice:
      "기존 맥락을 재개했습니다. 이 에이전트는 이전 메시지 표시를 지원하지 않습니다.",
  };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([resumed]);
    if (command === "subscribe_thread") return subscribeWith(args, resumed);
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: resumed.title }),
  );
  expect(
    await screen.findByRole("heading", { name: "첫 메시지를 기다리고 있어요" }),
  ).toBeTruthy();
  expect(screen.queryByText(resumed.notice)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the response indicator through streamed text until protocol completion", async () => {
  const ready = {
    id: "status",
    title: "Status thread",
    workingFolder: "/project",
    agentId: "codex",
    sessionId: "remote",
    createdAt: 1,
    updatedAt: 1,
    lastPromptAt: 1,
    interrupted: false,
    authentication: "authenticated",
    failure: null,
    completedTurnId: null,
    permissions: [],
    queuedMessages: [],
    configuration: [],
    status: "sessionReady",
    turns: [],
  };
  requests.mockImplementation(async (command) => {
    if (command === "subscription_snapshot") return ready;
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_threads") return [ready];
    if (command === "prepared_agents") return [{ id: "codex", name: "Codex" }];
    if (command === "subscribe_thread") return subscribeWith(args, ready);
    return "subscription";
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: ready.title }),
  );
  const active = {
    ...ready,
    status: "running",
    turns: [
      { id: "turn", message: "hello", responseParts: [], stopReason: null },
    ],
  };
  receive(active);
  const indicator = await screen.findByRole("status", { name: "응답 중…" });
  expect(indicator.querySelector(".animate-agent-waiting")).not.toBeNull();
  expect(await screen.findByRole("status", { name: "실행 중" })).toBeDefined();
  receive({ ...active, status: "waitingForApproval" });
  expect(await screen.findByText("승인 요청")).toBeDefined();
  expect(screen.getByRole("status", { name: "승인 대기" })).toBe(indicator);
  expect(indicator.querySelector(".animate-agent-waiting")).toBeNull();
  receive(active);
  receiveUpdate({
    kind: "textDelta",
    partId: "text-1",
    threadId: ready.id,
    turnId: "turn",
    text: "Hi",
  });
  await waitFor(() =>
    expect(indicator.previousElementSibling?.textContent).toContain("Hi"),
  );
  expect(screen.getByRole("status", { name: "응답 중…" })).toBe(indicator);
  expect(indicator.querySelector(".animate-agent-waiting")).not.toBeNull();
  expect(await screen.findByRole("status", { name: "실행 중" })).toBeDefined();
  const menu = threadMenu(ready.title);
  menu.focus();
  expect(document.activeElement).toBe(menu);
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("menuitem", { name: "삭제" })).toBeDefined();
  receive({ ...active, status: "cancelling" });
  expect(screen.getByRole("menuitem", { name: "삭제" })).toBeDefined();
  await userEvent.keyboard("{Escape}");
  expect(await screen.findByRole("status", { name: "중단 중" })).toBeDefined();
  expect(getSidebarThreadButton(ready.title).title).toBe("중단 중");
  expect(screen.queryByRole("status", { name: "응답 중…" })).toBeNull();
  receive({ ...active, status: "sessionReady", interrupted: true });
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "중단 중" })).toBeNull(),
  );
  receive({
    ...active,
    turns: [
      { id: "followup", message: "again", responseParts: [], stopReason: null },
    ],
  });
  expect(await screen.findByRole("status", { name: "응답 중…" })).toBeDefined();
  fireEvent.contextMenu(getSidebarThreadButton(ready.title));
  expect(await screen.findByRole("menuitem", { name: "삭제" })).toBeDefined();
  await userEvent.keyboard("{Escape}");
  receive({ ...active, status: "sessionReady", completedTurnId: "followup" });
  expect(screen.queryByRole("status", { name: "응답 중…" })).toBeNull();
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "미확인 완료" })).toBeNull(),
  );
});

function responseThread(id: string) {
  return {
    id,
    title: `Response ${id}`,
    workingFolder: "/project",
    agentId: "codex",
    sessionId: "remote",
    createdAt: 1,
    updatedAt: 1,
    lastPromptAt: 1,
    interrupted: false,
    authentication: "authenticated",
    failure: null,
    completedTurnId: null as string | null,
    permissions: [],
    queuedMessages: [],
    configuration: [],
    status: "sessionReady",
    turns: [],
  };
}

it.each([
  {
    status: "failed",
    failure: "processExited",
    message: "에이전트 프로세스가 종료되었습니다.",
  },
  {
    status: "sessionReady",
    storageError: "Thread storage unavailable",
    message: "Thread storage unavailable",
  },
])(
  "shows current thread errors only in the banner and preserves them on reentry: $message",
  async (error) => {
    const first = { ...responseThread("failed"), storageError: null, ...error };
    const second = responseThread("other");
    const original = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "list_threads") return Promise.resolve([first, second]);
      if (command === "subscribe_thread")
        return subscribeWith(
          args,
          (args as { id: string }).id === first.id ? first : second,
        );
      return original?.(command, args) ?? Promise.resolve();
    });
    render(() => <App />);
    await userEvent.click(
      await screen.findByRole("button", { name: first.title }),
    );
    await waitFor(() => expect(typeof receiveUpdate).toBe("function"));
    receiveUpdate({
      kind: "patch",
      thread: first,
      turnUpdates: [],
      errors: [
        {
          id: "failure-1",
          failure: first.failure,
          message: first.storageError,
        },
      ],
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (await screen.findByRole("status", { name: "스레드 오류" })).textContent,
    ).toContain(error.message);

    await userEvent.click(getSidebarThreadButton(second.title));
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "스레드 오류" })).toBeNull(),
    );
    await userEvent.click(getSidebarThreadButton(first.title));
    expect(
      (await screen.findByRole("status", { name: "스레드 오류" })).textContent,
    ).toContain(error.message);
    expect(screen.queryByRole("alert")).toBeNull();

    if (first.failure) {
      await userEvent.click(screen.getByRole("button", { name: "다시 연결" }));
      expect(invoke).toHaveBeenCalledWith("reconnect_thread", { id: first.id });
    } else {
      expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
    }

    receiveUpdate({
      kind: "patch",
      thread: {
        ...first,
        status: "sessionReady",
        failure: null,
        storageError: null,
      },
      turnUpdates: [],
    });
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "스레드 오류" })).toBeNull(),
    );
  },
);

it("reports request failure with one toast and no banner or sidebar error, without replaying it on reentry", async () => {
  const failed = {
    ...responseThread("request-failure"),
  };
  const other = responseThread("other-request");
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([failed, other]);
    if (command === "subscribe_thread")
      return subscribeWith(
        args,
        (args as { id: string }).id === failed.id ? failed : other,
      );
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: failed.title }),
  );
  await waitFor(() => expect(typeof receiveUpdate).toBe("function"));
  const event = {
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
  receiveUpdate(event);
  receiveUpdate(event);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "메시지 실행에 실패했습니다.",
  );
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.queryByRole("status", { name: "스레드 오류" })).toBeNull();
  expect(screen.queryByRole("status", { name: "요청 실패" })).toBeNull();
  expect(screen.queryByRole("status", { name: "연결 오류" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "알림 닫기" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await userEvent.click(getSidebarThreadButton(other.title));
  await userEvent.click(getSidebarThreadButton(failed.title));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "subscribe_thread",
      expect.objectContaining({ id: failed.id }),
    ),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("status", { name: "스레드 오류" })).toBeNull();
});

it("confirms completion only on the visible thread page and preserves it through cancellation and duplicate updates", async () => {
  const first = { ...responseThread("first"), completedTurnId: "first-turn" };
  const second = responseThread("second");
  let listUpdate!: (entries: Record<string, unknown>[]) => void;
  const channels = new Map<string, (update: Record<string, unknown>) => void>();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_threads") return [first, second];
    if (command === "prepared_agents") return [{ id: "codex", name: "Codex" }];
    if (command === "subscribe_thread_list") {
      listUpdate = (args as { channel: { onmessage: typeof listUpdate } })
        .channel.onmessage;
    }
    if (command === "subscribe_thread") {
      const id = (args as { id: string }).id;
      const update = (args as { channel: { onmessage: typeof receiveUpdate } })
        .channel.onmessage;
      channels.set(id, update);
      queueMicrotask(() =>
        update({ kind: "thread", thread: id === first.id ? first : second }),
      );
    }
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return [];
    return "subscription";
  });
  render(() => <App />);
  expect(
    await screen.findByRole("status", { name: "미확인 완료" }),
  ).toBeDefined();
  await userEvent.click(getSidebarThreadButton(first.title));
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "미확인 완료" })).toBeNull(),
  );
  await userEvent.click(getSidebarThreadButton(second.title));
  channels.get(first.id)?.({
    kind: "thread",
    thread: { ...first, completedTurnId: "late-first" },
  });
  listUpdate([{ ...first, completedTurnId: "late-first" }, second]);
  expect(
    await screen.findByRole("status", { name: "미확인 완료" }),
  ).toBeDefined();
  expect(
    getSidebarThreadButton(second.title).getAttribute("aria-current"),
  ).toBe("page");
  listUpdate([
    { ...first, completedTurnId: "late-first", status: "running" },
    second,
  ]);
  expect(await screen.findByRole("status", { name: "실행 중" })).toBeDefined();
  expect(screen.queryByRole("status", { name: "미확인 완료" })).toBeNull();
  listUpdate([
    { ...first, completedTurnId: "late-first", interrupted: true },
    second,
  ]);
  expect(
    await screen.findByRole("status", { name: "미확인 완료" }),
  ).toBeDefined();
  await userEvent.click(getSidebarThreadButton(first.title));
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "미확인 완료" })).toBeNull(),
  );
  await openAgentManagement();
  const newest = { ...first, completedTurnId: "while-settings" };
  listUpdate([newest, second]);
  channels.get(first.id)?.({ kind: "thread", thread: newest });
  expect(
    await screen.findByRole("status", { name: "미확인 완료" }),
  ).toBeDefined();
  await userEvent.click(getSidebarThreadButton(first.title));
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "미확인 완료" })).toBeNull(),
  );
  listUpdate([newest, second]);
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "미확인 완료" })).toBeNull(),
  );
  await userEvent.click(threadMenu(first.title));
  await userEvent.click(await screen.findByRole("menuitem", { name: "삭제" }));
  await userEvent.click(await screen.findByRole("button", { name: "삭제" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: first.title })).toBeNull(),
  );
  listUpdate([newest, second]);
  expect(screen.queryByRole("button", { name: first.title })).toBeNull();
});

it("keeps actual errors after list recovery and prioritizes subscription failure over progress", async () => {
  const first = {
    ...responseThread("errors"),
    failure: "connectionClosed",
    completedTurnId: "old",
  };
  let listUpdate!: (entries: Record<string, unknown>[]) => void;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_threads") return [first];
    if (command === "prepared_agents") return [{ id: "codex", name: "Codex" }];
    if (command === "subscribe_thread_list") {
      listUpdate = (args as { channel: { onmessage: typeof listUpdate } })
        .channel.onmessage;
      throw new Error("list unavailable");
    }
    if (command === "subscribe_thread") return subscribeWith(args, first);
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return [];
    return "subscription";
  });
  render(() => <App />);
  expect(
    await screen.findByRole("status", {
      name: "스레드 상태를 확인할 수 없습니다",
    }),
  ).toBeDefined();
  listUpdate([first]);
  expect(
    await screen.findByRole("status", { name: "연결 오류" }),
  ).toBeDefined();
  await userEvent.click(getSidebarThreadButton(first.title));
  expect(
    await screen.findByRole("status", { name: "연결 오류" }),
  ).toBeDefined();
  const recovered = {
    ...first,
    failure: null,
    status: "running",
    turns: [
      { id: "next", message: "try again", responseParts: [], stopReason: null },
    ],
  };
  await waitFor(() => expect(typeof receiveUpdate).toBe("function"));
  receive(recovered);
  expect(await screen.findByRole("status", { name: "실행 중" })).toBeDefined();
  receiveUpdate({
    kind: "textDelta",
    partId: "text-1",
    threadId: first.id,
    turnId: "wrong-turn",
    text: "bad",
  });
  expect(
    await screen.findByRole("status", {
      name: "스레드 상태를 확인할 수 없습니다",
    }),
  ).toBeDefined();
  expect(screen.queryByRole("status", { name: "응답 중…" })).toBeNull();
  receive({
    ...recovered,
    status: "waitingForApproval",
    failure: "connectionClosed",
  });
  expect(
    await screen.findByRole("status", { name: "연결 오류" }),
  ).toBeDefined();
  expect(screen.queryByText("승인 요청")).toBeNull();
  await userEvent.click(threadMenu(first.title));
  expect(await screen.findByRole("menuitem", { name: "삭제" })).toBeDefined();
});

it("retries the failed list subscription and keeps rows and connection errors during recovery", async () => {
  const first = {
    ...responseThread("retry-list"),
    failure: "connectionClosed",
  };
  let attempts = 0;
  let deliver!: () => void;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_threads") return [first];
    if (command === "prepared_agents") return [];
    if (command === "subscribe_thread_list") {
      attempts++;
      if (attempts === 1) throw new Error("registration failed");
      deliver = () =>
        (
          args as { channel: { onmessage: (entries: unknown[]) => void } }
        ).channel.onmessage([first]);
    }
    return "subscription";
  });
  render(() => <App />);
  expect(
    await screen.findByRole("status", {
      name: "스레드 상태를 확인할 수 없습니다",
    }),
  ).toBeDefined();
  await userEvent.click(
    screen.getByRole("button", { name: "목록 다시 불러오기" }),
  );
  await waitFor(() => expect(attempts).toBe(2));
  expect(getSidebarThreadButton(first.title)).toBeDefined();
  expect(
    screen.getByRole("status", { name: "스레드 상태를 확인할 수 없습니다" }),
  ).toBeDefined();
  deliver();
  expect(
    await screen.findByRole("status", { name: "연결 오류" }),
  ).toBeDefined();
});
