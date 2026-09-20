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
const receive = (thread: Record<string, unknown>) =>
  receiveUpdate({ kind: "thread", thread });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    await userEvent.click(
      screen.getByRole("button", { name: "에이전트 관리" }),
    );
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.resetAllMocks();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "subscribe_thread_list")
      return Promise.resolve("list-subscription");
    if (command === "list_threads") return Promise.resolve([]);
    if (command === "prepared_agents")
      return Promise.resolve([{ id: "codex", name: "Codex" }]);
    if (command === "subscribe_thread") {
      receiveUpdate = (args as { channel: { onmessage: typeof receiveUpdate } })
        .channel.onmessage;
      return Promise.resolve("subscription-1");
    }
    if (command === "unsubscribe_thread") return Promise.resolve();
    return requests(command, args);
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

it("groups threads by folder, collapses projects and creates within the selected folder", async () => {
  const saved = {
    id: "one",
    title: "First project task",
    workingFolder: "/work/project",
    agentId: "codex",
    status: "sessionReady",
    revision: 0,
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
    if (command === "create_thread")
      return {
        ...saved,
        id: "new",
        title: "새 스레드",
        status: "disconnected",
      };
    if (command === "connect_thread")
      return { ...saved, id: "new", title: "새 스레드", revision: 1 };
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
  await userEvent.click(screen.getByRole("button", { name: "사이드바 닫기" }));
  expect(screen.queryByRole("navigation", { name: "스레드 목록" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "사이드바 열기" }));
  await userEvent.click(
    screen.getByRole("button", { name: "project에 새 스레드" }),
  );
  expect(invoke).toHaveBeenCalledWith("create_thread", {
    folder: "/work/project",
    agentId: "codex",
  });
  expect(invoke).toHaveBeenCalledWith("connect_thread", { id: "new" });
});

it("opens the same delete action from the row menu and right click, then cancels safely", async () => {
  const saved = {
    id: "delete-me",
    title: "삭제할 초안",
    workingFolder: "/work/project",
    agentId: "codex",
    status: "disconnected",
    remoteSessionId: "remote-delete-me",
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
    remoteSessionId: null,
    authentication: "authenticated",
    revision: 1,
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
    if (command === "get_thread") return Promise.resolve(selected);
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
    remoteSessionId: null,
    revision: 0,
    turns: [],
    permissions: [],
    queuedMessages: [],
  };
  let finishOpen!: (thread: typeof saved) => void;
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([saved]);
    if (command === "get_thread")
      return new Promise<typeof saved>((resolve) => {
        finishOpen = resolve;
      });
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
    revision: 1,
    turns: [],
    permissions: [],
    queuedMessages: [],
  };
  const other = { ...current, id: "other", title: "다른 스레드" };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([current, other]);
    if (command === "get_thread") return Promise.resolve(current);
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
    await screen.findByRole("heading", { name: "계속 작업" }),
  ).toBeTruthy();
  expect(screen.getByRole("textbox")).toHaveProperty("value", "유지할 입력");
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
    remoteSessionId: "remote-7",
    turns: [],
    permissions: [],
    revision: 0,
    failure: null,
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "prepared_agents" || command === "agent_catalog") return [];
    if (command === "list_threads") return [saved];
    if (command === "get_thread") return saved;
    if (command === "connect_thread")
      return {
        ...saved,
        status: "failed",
        failure: "agentRemoved",
        revision: 1,
      };
    if (command === "subscribe_thread") {
      receiveUpdate = (args as { channel: { onmessage: typeof receiveUpdate } })
        .channel.onmessage;
      return "subscription";
    }
  });
  render(() => <App />);
  await screen.findByRole("button", { name: "지난 작업" });
  expect(screen.getByRole("button", { name: "지난 작업 메뉴" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "에이전트 관리" })).toBeNull();
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
  await screen.findByRole("heading", { name: "에이전트 관리" });
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
    remoteSessionId: "remote-7",
    turns: [],
    permissions: [],
    revision: 0,
    failure: null,
  };
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([saved]);
    if (command === "get_thread") return Promise.resolve(saved);
    if (command === "connect_thread")
      return Promise.resolve({ ...saved, status: "connecting", revision: 1 });
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "저장된 제목" }),
  );
  await screen.findByText("이전 스레드를 불러오는 중…");
  expect(screen.getByRole("button", { name: "전송" })).toHaveProperty(
    "disabled",
    true,
  );
  receive({
    ...saved,
    title: "복원한 제목",
    status: "sessionReady",
    revision: 3,
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
  receive({ ...saved, revision: 1 });
  expect(
    await screen.findByRole("button", { name: "복원한 제목" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "저장된 제목" })).toBeNull();
  await userEvent.type(screen.getByRole("textbox"), "작성 중인 질문");
  await userEvent.click(screen.getByRole("button", { name: "복원한 제목" }));
  expect(screen.getByRole("textbox")).toHaveProperty("value", "작성 중인 질문");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "get_thread"),
  ).toHaveLength(1);
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

it("returns from setup to the same thread and resumes only after an explicit retry", async () => {
  const saved = {
    id: "saved-auth",
    title: "인증이 필요한 작업",
    agentId: "codex",
    workingFolder: "/project",
    status: "disconnected",
    remoteSessionId: "same-remote",
    turns: [],
    permissions: [],
    revision: 0,
    failure: null,
  };
  let attempts = 0;
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "list_threads") return Promise.resolve([saved]);
    if (command === "get_thread") return Promise.resolve(saved);
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return Promise.resolve([]);
    if (command === "connect_thread") {
      expect(args).toEqual({ id: saved.id });
      attempts++;
      return Promise.resolve(
        attempts === 1
          ? {
              ...saved,
              status: "failed",
              failure: "authenticationRequired",
              revision: 1,
            }
          : {
              ...saved,
              status: "sessionReady",
              revision: 2,
              notice:
                "기존 맥락을 재개했습니다. 이 에이전트는 이전 메시지 표시를 지원하지 않습니다.",
            },
      );
    }
    return original?.(command, args) ?? Promise.resolve();
  });
  render(() => <App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "인증이 필요한 작업" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "로그인 안내 열기" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "스레드로 돌아가기" }),
  );
  expect(screen.getByRole("heading", { name: saved.title })).toBeTruthy();
  expect(attempts).toBe(1);
  await userEvent.click(screen.getByRole("button", { name: "다시 연결" }));
  expect(
    await screen.findByText(/이전 메시지 표시를 지원하지 않습니다/),
  ).toBeTruthy();
  expect(attempts).toBe(2);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "send_message"),
  ).toBe(false);
});

it("automatically connects a new thread and disables sending while connecting", async () => {
  const draft = {
    revision: 0,
    turns: [],
    authentication: "unknown",
    id: "draft-1",
    workingFolder: "/Users/test/작업",
    agentId: "codex",
    status: "disconnected",
  };
  requests
    .mockResolvedValueOnce(draft)
    .mockResolvedValueOnce({ ...draft, status: "connecting", revision: 1 });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(await screen.findByTitle("/Users/test/작업")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "새 스레드" })).toBeTruthy();
  expect(screen.getByText("연결 중…")).toBeTruthy();
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

it("keeps the current thread when another folder selection is cancelled", async () => {
  requests
    .mockResolvedValueOnce({
      id: "draft-1",
      revision: 0,
      workingFolder: "/Users/test/project",
      agentId: "codex",
      status: "disconnected",
    })
    .mockResolvedValueOnce({
      id: "draft-1",
      revision: 1,
      workingFolder: "/Users/test/project",
      agentId: "codex",
      status: "sessionReady",
    })
    .mockResolvedValueOnce(null);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await screen.findByTitle("/Users/test/project");
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(screen.getByTitle("/Users/test/project")).toBeTruthy();
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
        revision: 0,
        turns: [],
        authentication: "unknown",
        id: "draft-1",
        workingFolder: "/project",
        agentId: "codex",
        status: "disconnected",
      };
    if (command === "connect_thread")
      return {
        revision: 0,
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
      remoteSessionId: "remote-1",
    };
  });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(await screen.findByText("연결 중…")).toBeTruthy();
  receive({
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    revision: 2,
    turns: [],
    authentication: "unknown",
  });
  expect(await screen.findByText("세션 준비 완료")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  expect(
    screen.getByText("인증 상태는 아직 확인되지 않았습니다."),
  ).toBeTruthy();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("connect_thread", {
    id: "draft-1",
  });
});

it("shows authentication failures and retries only when requested", async () => {
  const draft = {
    revision: 0,
    turns: [],
    authentication: "unknown",
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "disconnected",
  };
  let thread = draft;
  requests.mockImplementation(async (command) => {
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
  expect((await screen.findByRole("alert")).textContent).toContain(
    "로그인이 필요합니다",
  );
  expect(
    screen.queryByText("인증 상태는 아직 확인되지 않았습니다."),
  ).toBeNull();
  expect(
    requests.mock.calls.filter(([command]) => command === "connect_thread"),
  ).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "다시 연결" }));
  expect(
    requests.mock.calls.filter(([command]) => command === "connect_thread"),
  ).toHaveLength(2);
});

it("shows process exit after readiness without reconnecting automatically", async () => {
  const draft = {
    revision: 0,
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
  expect(await screen.findByText("세션 준비 완료")).toBeTruthy();
  receive({
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "failed",
    failure: "processExited",
    revision: 3,
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
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "list_threads"
      ? Promise.resolve([])
      : command === "prepared_agents"
        ? Promise.resolve([
            { id: "codex", name: "Codex" },
            { id: "fixture", name: "Fixture" },
          ])
        : requests(command, args),
  );
  requests.mockResolvedValue({
    revision: 0,
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
  await userEvent.selectOptions(screen.getByRole("combobox"), "codex");
  expect(invoke).toHaveBeenCalledWith("connect_thread", {
    id: "draft-1",
  });
  expect(screen.getAllByText("Fixture")).toHaveLength(2);
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
    revision: 2,
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
    text: "첫 줄\n둘째 줄",
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
    revision: 1,
    turns: [],
  };
  requests.mockResolvedValue(connecting);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));

  const input = screen.getByRole("textbox");
  expect(document.activeElement).not.toBe(input);

  receive({ ...connecting, status: "sessionReady", revision: 2 });

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
    revision: 1,
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
  expect(viewport.style.scrollPaddingBottom).toBe("192px");
});

it("sends once, renders streaming text and completion, and admits the next message", async () => {
  const ready = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    revision: 2,
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
          finish = () =>
            resolve({
              ...ready,
              status: "running",
              revision: 3,
              turns: [
                {
                  id: "turn-1",
                  message: "hello",
                  response: "Hi",
                  stopReason: null,
                },
              ],
            });
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
  receive({ ...ready, status: "running", revision: 3, turns: [turn] });
  finish();
  expect(await screen.findByText("Hi")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "전송" })).toBeNull();
  expect(screen.getByRole("button", { name: "현재 작업 중단" })).toBe(button);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  receive({
    ...ready,
    revision: 4,
    turns: [{ ...turn, response: "Hi there", stopReason: "end_turn" }],
  });
  expect(await screen.findByText("Hi there")).toBeTruthy();
  expect(screen.getByText("완료")).toBeTruthy();
  receive({ ...ready, status: "running", revision: 3, turns: [turn] });
  expect(screen.queryByText("Hi", { exact: true })).toBeNull();
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
    revision: 1,
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
    revision: 2,
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
    text: "next instruction with details",
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
    revision: 3,
    status: "sessionReady",
  });
  await userEvent.click(screen.getByRole("button", { name: "현재 작업 중단" }));
  expect(
    screen.getAllByRole("button", { name: /대기 메시지 삭제/ }),
  ).toHaveLength(2);
  requests.mockResolvedValue({
    ...queued,
    revision: 4,
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
    revision: 2,
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
    revision: 3,
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
    revision: 2,
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
  receive({ ...ready, revision: 3, notice: "should not appear" });
  expect(screen.queryByText("should not appear")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("unsubscribe_thread", {
    subscription: "late-subscription",
  });
});

it("appends each text delta once and rejects updates for another thread", async () => {
  const ready = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "running",
    revision: 2,
    turns: [{ id: "turn-1", message: "hello", response: "", stopReason: null }],
  };
  requests.mockResolvedValue(ready);
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  const delta = {
    kind: "textDelta",
    threadId: "draft-1",
    revision: 3,
    turnId: "turn-1",
    text: "Hello",
  };
  receiveUpdate(delta);
  receiveUpdate(delta);
  receiveUpdate({
    ...delta,
    threadId: "other",
    revision: 4,
    text: "wrong",
  });
  receiveUpdate({ ...delta, revision: 4, text: " world" });
  expect(screen.getByText("Hello world")).toBeTruthy();
  expect(screen.queryByText(/wrong/)).toBeNull();
});

it("does not disable the new thread when old subscription cleanup fails", async () => {
  const ready = {
    id: "draft-1",
    workingFolder: "/project",
    agentId: "codex",
    status: "sessionReady",
    revision: 2,
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
  expect(
    await screen.findByRole("heading", { name: "에이전트 관리" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Codex 설치" })).toBeTruthy();
});

it("returns from project setup to create in the original folder", async () => {
  let installed = false;
  const saved = {
    id: "saved",
    title: "Saved task",
    workingFolder: "/work/original",
    agentId: "missing",
    status: "disconnected",
    revision: 0,
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
    if (command === "create_thread")
      return {
        ...saved,
        id: "new",
        title: "새 스레드",
        agentId: "new-provider",
      };
    if (command === "connect_thread")
      return {
        ...saved,
        id: "new",
        title: "새 스레드",
        agentId: "new-provider",
        status: "sessionReady",
        revision: 1,
      };
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
    screen.getByRole("button", { name: "스레드로 돌아가기" }),
  );
  await screen.findByRole("heading", { name: "새 스레드" });
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
    revision: 2,
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
  await userEvent.click(screen.getByRole("button", { name: "에이전트 관리" }));
  receiveUpdate({
    kind: "textDelta",
    threadId: "draft-1",
    revision: 3,
    turnId: "turn-1",
    text: " there",
  });
  await userEvent.click(
    screen.getByRole("button", { name: "스레드로 돌아가기" }),
  );
  expect(screen.getByText("Hi there")).toBeTruthy();
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
  await userEvent.click(screen.getByRole("button", { name: "에이전트 관리" }));
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
  await userEvent.click(
    screen.getByRole("button", { name: "스레드로 돌아가기" }),
  );
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
    if (command === "prepared_agents") return [];
    if (command === "refresh_agent_catalog") throw "Registry 갱신 실패";
    if (command === "agent_catalog") return agents;
  });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "에이전트 관리" }));
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

it("confirms uninstall, supports cancel and retry, and removes the agent from new thread choices", async () => {
  let installed = true;
  let attempts = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
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
  await userEvent.click(screen.getByRole("button", { name: "에이전트 관리" }));
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
  await userEvent.click(
    screen.getByRole("button", { name: "스레드로 돌아가기" }),
  );
  expect(screen.queryByRole("option", { name: "New Provider" })).toBeNull();
});

it("keeps thread content after agent removal and offers setup and explicit retry", async () => {
  const draft = {
    id: "removed-chat",
    workingFolder: "/Users/test/project",
    agentId: "codex",
    status: "disconnected",
    revision: 0,
  };
  requests
    .mockResolvedValueOnce(draft)
    .mockResolvedValueOnce({ ...draft, status: "connecting", revision: 1 });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  await screen.findByText("연결 중…");
  receive({
    ...draft,
    status: "failed",
    failure: "agentRemoved",
    revision: 2,
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
    revision: 2,
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
    revision: 4,
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
  resolve({ ...ready, status: "running", revision: 5, turns: [turn] });
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
      revision: 4,
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
      revision: 5,
      permissions: [],
    });
    await userEvent.click(
      screen.getByRole("button", { name: "현재 작업 중단" }),
    );
    expect(invoke).toHaveBeenCalledWith("cancel_turn", {
      id: "draft-1",
      turn: "turn-1",
    });
    expect(await screen.findByText("중단 중…")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "현재 작업 중단" }),
    ).toHaveProperty("disabled", true);
    receive(waiting);
    expect(screen.queryByRole("button", { name: "Run once" })).toBeNull();
    receive({
      ...waiting,
      status: "sessionReady",
      revision: 6,
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
