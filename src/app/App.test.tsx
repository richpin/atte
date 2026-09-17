import { cleanup, render, screen } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);
const requests = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(invoke).mockImplementation((command, args) =>
    command === "prepared_agents"
      ? Promise.resolve([{ id: "codex", name: "Codex" }])
      : requests(command, args),
  );
});

it("opens the selected folder as a disconnected empty conversation", async () => {
  requests.mockResolvedValueOnce({
    id: "draft-1",
    workingFolder: "/Users/test/작업",
    agentId: "codex",
    status: "disconnected",
  });
  render(() => <App />);
  await userEvent.click(screen.getByRole("button", { name: "폴더 선택" }));
  expect(await screen.findByText("/Users/test/작업")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "새 대화" })).toBeTruthy();
  expect(screen.getByText("연결 전")).toBeTruthy();
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
      workingFolder: "/Users/test/project",
      agentId: "codex",
      status: "disconnected",
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
        id: "draft-1",
        workingFolder: "/project",
        agentId: "codex",
        status: "disconnected",
      };
    if (command === "connect_conversation")
      return {
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
  await userEvent.click(screen.getByRole("button", { name: "에이전트 연결" }));
  expect(await screen.findByText("연결 중…")).toBeTruthy();
  expect(await screen.findByText("세션 준비 완료")).toBeTruthy();
  expect(
    screen.getByText("인증 상태는 아직 확인되지 않았습니다."),
  ).toBeTruthy();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("connect_conversation", {
    id: "draft-1",
  });
});

it("shows authentication failures and retries only when requested", async () => {
  const draft = {
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
  await userEvent.click(screen.getByRole("button", { name: "에이전트 연결" }));
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
  await userEvent.click(screen.getByRole("button", { name: "에이전트 연결" }));
  expect(await screen.findByText("세션 준비 완료")).toBeTruthy();
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
  await userEvent.click(screen.getByRole("button", { name: "에이전트 연결" }));
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
  await userEvent.click(screen.getByRole("button", { name: "에이전트 연결" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "폴더를 다시 선택해주세요",
  );
});
