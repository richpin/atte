import { cleanup, render, screen } from "@solidjs/testing-library";
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
const receive = (snapshot: Record<string, unknown>) =>
  receiveUpdate({ kind: "snapshot", snapshot });
afterEach(cleanup);
const requests = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "prepared_agents")
      return Promise.resolve([{ id: "codex", name: "Codex" }]);
    if (command === "subscribe_conversation") {
      receiveUpdate = (args as { channel: { onmessage: typeof receiveUpdate } })
        .channel.onmessage;
      return Promise.resolve("subscription-1");
    }
    if (command === "unsubscribe_conversation") return Promise.resolve();
    return requests(command, args);
  });
});

it("automatically connects a new conversation and disables sending while connecting", async () => {
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
  expect(await screen.findByText("/Users/test/작업")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "새 대화" })).toBeTruthy();
  expect(screen.getByText("연결 중…")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("connect_conversation", {
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
  expect(invoke).not.toHaveBeenCalledWith(
    "connect_conversation",
    expect.anything(),
  );
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

it("keeps the current conversation when another folder selection is cancelled", async () => {
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
  await screen.findByText("/Users/test/project");
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(screen.getByText("/Users/test/project")).toBeTruthy();
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
    if (command === "connect_conversation")
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
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("connect_conversation", {
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
  let snapshot = draft;
  requests.mockImplementation(async (command) => {
    if (command === "select_working_folder") return draft;
    if (command === "connect_conversation") {
      snapshot = { ...draft, status: "failed" };
      return {
        ...snapshot,
        authentication: "required",
        failure: "authenticationRequired",
      };
    }
    return {
      ...snapshot,
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
    requests.mock.calls.filter(
      ([command]) => command === "connect_conversation",
    ),
  ).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "다시 연결" }));
  expect(
    requests.mock.calls.filter(
      ([command]) => command === "connect_conversation",
    ),
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
    if (command === "connect_conversation")
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
    requests.mock.calls.filter(
      ([command]) => command === "connect_conversation",
    ),
  ).toHaveLength(1);
});

it("keeps the existing conversation's agent fixed when selecting a target for the next one", async () => {
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "prepared_agents"
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
  });
  await userEvent.selectOptions(screen.getByRole("combobox"), "codex");
  expect(invoke).toHaveBeenCalledWith("connect_conversation", {
    id: "draft-1",
  });
  expect(screen.getAllByText("Fixture")).toHaveLength(2);
});

it("reports prepared-agent loading failure without crashing the page", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("offline"));
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
    if (command === "connect_conversation")
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
    requests.mock.calls.filter(
      ([command]) => command === "connect_conversation",
    ),
  ).toHaveLength(1);
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
  expect((button as HTMLButtonElement).disabled).toBe(true);
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
      throw { message: "응답이 완료된 연결된 대화에서 전송해주세요." };
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
    if (command === "prepared_agents")
      return Promise.resolve([{ id: "codex", name: "Codex" }]);
    if (command === "subscribe_conversation") {
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
  expect(invoke).toHaveBeenCalledWith("unsubscribe_conversation", {
    subscription: "late-subscription",
  });
});

it("appends each text delta once and rejects updates for another conversation", async () => {
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
    conversationId: "draft-1",
    revision: 3,
    turnId: "turn-1",
    text: "Hello",
  };
  receiveUpdate(delta);
  receiveUpdate(delta);
  receiveUpdate({
    ...delta,
    conversationId: "other",
    revision: 4,
    text: "wrong",
  });
  receiveUpdate({ ...delta, revision: 4, text: " world" });
  expect(screen.getByText("Hello world")).toBeTruthy();
  expect(screen.queryByText(/wrong/)).toBeNull();
});

it("does not disable the new conversation when old subscription cleanup fails", async () => {
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
    if (command === "unsubscribe_conversation")
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

it("opens agent management when no agent is installed", async () => {
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
  expect(
    await screen.findByRole("heading", { name: "에이전트 관리" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Codex 설치" })).toBeTruthy();
});

it("keeps streaming and the fixed conversation while management is open", async () => {
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
    conversationId: "draft-1",
    revision: 3,
    turnId: "turn-1",
    text: " there",
  });
  await userEvent.click(
    screen.getByRole("button", { name: "대화로 돌아가기" }),
  );
  expect(screen.getByText("Hi there")).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith(
    "unsubscribe_conversation",
    expect.anything(),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "subscribe_conversation"),
  ).toHaveLength(1);
});

it("retries a failed install and offers the installed agent without restarting", async () => {
  let installed = false;
  let attempts = 0;
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
      installed = true;
    }
    if (command === "select_working_folder") {
      expect(args).toEqual({ agentId: "new-provider" });
      return null;
    }
  });
  render(() => <App />);
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
  expect(await screen.findByText(/설치됨 · 1.12.0/)).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "대화로 돌아가기" }),
  );
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
    "new-provider",
  );
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(invoke).toHaveBeenCalledWith("select_working_folder", {
    agentId: "new-provider",
  });
});

it("shows new registry agents and unsupported reasons while keeping cached installations on refresh failure", async () => {
  let fail = false;
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
    if (command === "refresh_agent_catalog" && fail) throw "Registry 갱신 실패";
    if (command === "agent_catalog" || command === "refresh_agent_catalog")
      return agents;
  });
  render(() => <App />);
  expect(
    await screen.findByRole("button", { name: "New Provider 설치" }),
  ).toHaveProperty("disabled", false);
  expect(screen.getByText("From registry")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "UV Provider 설치" }),
  ).toHaveProperty("disabled", true);
  expect(screen.getByText("지원하지 않는 배포 형식입니다.")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "External auth · 미지원 인증" }),
  ).toHaveProperty("disabled", true);
  fail = true;
  await userEvent.click(screen.getByRole("button", { name: "목록 새로고침" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Registry 갱신 실패",
  );
  expect(screen.getByText("설치됨 · 2.0.0")).toBeTruthy();
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

it("can stop a turn while approval is pending and ignores a late approval snapshot", async () => {
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
    status: "waitingForApproval",
    revision: 4,
    turns: [turn],
    permissions: [
      {
        id: "p1",
        title: "Run command",
        details: "echo test",
        options: [{ id: "yes-42", name: "Run once" }],
      },
    ],
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
  await userEvent.click(screen.getByRole("button", { name: "현재 작업 중단" }));
  expect(invoke).toHaveBeenCalledWith("cancel_turn", {
    id: "draft-1",
    turn: "turn-1",
  });
  expect(await screen.findByText("중단 중…")).toBeTruthy();
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
});
