import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
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
      <GitPanel
        threadId="git-panel-test"
        visible
        onOpenCommit={() => {}}
        onOpenFile={() => {}}
      />
    </QueryClientProvider>
  ));
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "변경 사항 2" })).toBeTruthy(),
  );
  expect(
    screen.getByRole("button", { name: "현재 작업 브랜치 main" }),
  ).toBeTruthy();
  expect(screen.getAllByText("a")).toHaveLength(2);
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
        onOpenFile={() => {}}
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
