import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  commitChanges,
  readWorkingChanges,
  stageFiles,
} from "../../api/git-working";
import { GitPanel } from "./GitPanel";

vi.mock("../../api/git-working", async (original) => ({
  ...(await original<object>()),
  readWorkingChanges: vi.fn(),
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  commitChanges: vi.fn(),
}));
vi.mock("../../api/git-history", async (original) => ({
  ...(await original<object>()),
  openHistory: vi.fn(),
}));

const snapshot = {
  root: "/repo",
  branch: "main",
  head: "head",
  indexTree: "tree",
  revision: "revision",
  latestStash: null,
  operation: null,
  files: [
    {
      id: "61",
      path: "a",
      oldPath: null,
      oldId: null,
      status: "MM",
      staged: true,
      unstaged: true,
      conflict: false,
      submodule: false,
      exists: true,
      stagedChange: {
        oldPath: null,
        additions: 1,
        deletions: 0,
        revision: "a-staged",
      },
      unstagedChange: {
        oldPath: null,
        additions: 1,
        deletions: 1,
        revision: "a-unstaged",
      },
    },
    {
      id: "62",
      path: "b",
      oldPath: null,
      oldId: null,
      status: "??",
      staged: false,
      unstaged: true,
      conflict: false,
      submodule: false,
      exists: true,
      stagedChange: null,
      unstagedChange: {
        oldPath: null,
        additions: 1,
        deletions: 0,
        revision: "b-unstaged",
      },
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("shows staged and unstaged entries and commits only the staged index", async () => {
  vi.mocked(readWorkingChanges).mockResolvedValue(snapshot);
  vi.mocked(commitChanges).mockResolvedValue({
    ...snapshot,
    head: "new-head",
    files: [snapshot.files[0], snapshot.files[1]],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(() => (
    <QueryClientProvider client={client}>
      <GitPanel threadId="git-panel-test" visible onOpenCommit={() => {}} />
    </QueryClientProvider>
  ));
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "변경 사항 2" })).toBeTruthy(),
  );
  expect(
    screen.getByRole("button", { name: "현재 작업 브랜치 main" }),
  ).toBeTruthy();
  expect(screen.getAllByText("a")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: /^커밋$/ }));
  fireEvent.input(screen.getByRole("textbox", { name: "커밋 제목" }), {
    target: { value: "feat: add a" },
  });
  fireEvent.click(screen.getByRole("button", { name: "스테이징된 변경 커밋" }));
  await waitFor(() =>
    expect(commitChanges).toHaveBeenCalledWith(
      "git-panel-test",
      "feat: add a",
      "head",
      "tree",
    ),
  );
  expect(stageFiles).not.toHaveBeenCalled();
});

it("keeps refresh available when the first Changes request fails", async () => {
  vi.mocked(readWorkingChanges)
    .mockRejectedValueOnce(new Error("temporary failure"))
    .mockResolvedValue(snapshot);
  render(() => (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <GitPanel
        threadId="git-panel-refresh-test"
        visible
        onOpenCommit={() => {}}
      />
    </QueryClientProvider>
  ));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Git 상태 새로고침" }));
  await screen.findByRole("button", { name: "현재 작업 브랜치 main" });
  expect(
    vi.mocked(readWorkingChanges).mock.calls.length,
  ).toBeGreaterThanOrEqual(2);
});

it("keeps the commit dialog and draft after a failed commit", async () => {
  vi.mocked(readWorkingChanges).mockResolvedValue(snapshot);
  vi.mocked(commitChanges).mockRejectedValue(new Error("commit hook failed"));
  render(() => (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <GitPanel
        threadId="git-panel-failed-commit"
        visible
        onOpenCommit={() => {}}
      />
    </QueryClientProvider>
  ));
  await screen.findByRole("tab", { name: "변경 사항 2" });
  fireEvent.click(await screen.findByRole("button", { name: /^커밋$/ }));
  fireEvent.input(screen.getByRole("textbox", { name: "커밋 제목" }), {
    target: { value: "fix: preserve draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "스테이징된 변경 커밋" }));
  await screen.findAllByText("commit hook failed");
  expect(
    (screen.getByRole("textbox", { name: "커밋 제목" }) as HTMLInputElement)
      .value,
  ).toBe("fix: preserve draft");
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("offers bulk Git actions and confirms Restore All before changing files", async () => {
  vi.mocked(readWorkingChanges).mockResolvedValue(snapshot);
  render(() => (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <GitPanel threadId="git-panel-bulk" visible onOpenCommit={() => {}} />
    </QueryClientProvider>
  ));
  await screen.findByRole("tab", { name: "변경 사항 2" });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Git 작업 더 보기" }));
  expect(screen.getByRole("menuitem", { name: "모두 스테이징" })).toBeTruthy();
  expect(
    screen.getByRole("menuitem", { name: "모두 스테이징 해제" }),
  ).toBeTruthy();
  await userEvent
    .setup()
    .click(screen.getByRole("menuitem", { name: "모든 변경 복원" }));
  expect(screen.getByRole("dialog", { name: "복원" })).toBeTruthy();
});
