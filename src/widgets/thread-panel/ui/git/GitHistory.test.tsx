import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closeHistory,
  type GitCommit,
  openHistory,
  readCommit,
  readPage,
} from "../../api/git-history";
import { readWorkingChanges } from "../../api/git-working";
import { createThreadPanelModel } from "../create-thread-panel-model";
import { ThreadPanel } from "../ThreadPanel";
import { GitHistory } from "./GitHistory";

vi.mock("../../api/git-working", async (original) => ({
  ...(await original<object>()),
  readWorkingChanges: vi.fn(),
}));

vi.mock("../../api/git-history", async (original) => ({
  ...(await original<object>()),
  openHistory: vi.fn(),
  readPage: vi.fn(),
  closeHistory: vi.fn(),
  readCommit: vi.fn(),
}));
class ResizeObserverFixture {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const commit = (index: number): GitCommit => ({
  oid: `commit-${index}`,
  parents: [`commit-${index + 1}`],
  subject: `Subject ${index}`,
  author: "Author",
  timestamp: 1700000000,
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("ResizeObserver", ResizeObserverFixture);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  vi.mocked(closeHistory).mockResolvedValue();
  vi.mocked(openHistory).mockResolvedValue({
    repository: {
      root: "/repo",
      references: [],
      head: "commit-0",
      shallow: false,
    },
    page: {
      commits: Array.from({ length: 200 }, (_, index) => commit(index)),
      cursor: "cursor",
    },
  });
  vi.mocked(readPage).mockResolvedValue({
    commits: [commit(200)],
    cursor: null,
  });
  vi.mocked(readCommit).mockResolvedValue({
    commit: commit(0),
    body: "",
    base: "parent",
    boundary: false,
    files: [],
  });
  vi.mocked(readWorkingChanges).mockResolvedValue({
    root: "/repo",
    branch: "main",
    head: "commit-0",
    indexTree: "tree",
    operation: null,
    files: [],
  });
});

it("opens Git from the tab chooser and reuses a commit diff tab", async () => {
  let model!: ReturnType<typeof createThreadPanelModel>;
  render(() => {
    model = createThreadPanelModel();
    model.setOpen("thread", true);
    const panel = model.panel("thread");
    if (!panel) throw new Error("Missing test panel");
    return (
      <QueryClientProvider client={new QueryClient()}>
        <ThreadPanel model={model} panel={panel} visible />
      </QueryClientProvider>
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Git" }));
  fireEvent.click(await screen.findByRole("tab", { name: "커밋 이력" }));
  await screen.findByRole("button", { name: "Subject 0 · commit-" });
  fireEvent.click(screen.getByRole("button", { name: "Subject 0 · commit-" }));
  await screen.findByText("파일 변경사항이 없는 커밋입니다.");
  expect(
    model.panel("thread")?.tabs.filter((tab) => tab.id.startsWith("commit:")),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("tab", { name: "Git" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Subject 0 · commit-" }),
  );
  expect(
    model.panel("thread")?.tabs.filter((tab) => tab.id.startsWith("commit:")),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Git 닫기" }));
  expect(closeHistory).toHaveBeenCalledWith("thread", "cursor");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "scrollTo");
});

it("renders a bounded number of rows and loads the next page when scrolled near the end", async () => {
  const open = vi.fn();
  const { container } = render(() => (
    <GitHistory threadId="thread" visible onOpenCommit={open} />
  ));
  await screen.findByRole("button", { name: "Subject 0 · commit-" });
  expect(openHistory).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll("[data-commit-index]").length).toBeLessThan(
    40,
  );
  expect(readPage).not.toHaveBeenCalled();
  fireEvent.click(
    container.querySelector('[data-commit-index="0"]') as HTMLElement,
  );
  expect(open).toHaveBeenCalledWith(
    "/repo",
    expect.objectContaining({ oid: "commit-0" }),
  );
  const list = screen.getByRole("list", { name: "커밋 이력" });
  const scrollRoot = list.parentElement as HTMLElement;
  scrollRoot.scrollTop = 10200;
  fireEvent.scroll(scrollRoot);
  await waitFor(() =>
    expect(readPage).toHaveBeenCalledWith("thread", "cursor"),
  );
  expect(container.querySelectorAll("[data-commit-index]").length).toBeLessThan(
    40,
  );
});
it("waits for first visibility and preserves the loaded snapshot across tab switches", async () => {
  const [visible, setVisible] = createSignal(false);
  render(() => (
    <GitHistory threadId="thread" visible={visible()} onOpenCommit={() => {}} />
  ));
  expect(openHistory).not.toHaveBeenCalled();
  setVisible(true);
  await screen.findByRole("button", { name: "Subject 0 · commit-" });
  setVisible(false);
  setVisible(true);
  expect(openHistory).toHaveBeenCalledTimes(1);
  cleanup();
  expect(closeHistory).toHaveBeenCalledWith("thread", "cursor");
});

it("refreshes history from the button beside the branch scope", async () => {
  render(() => (
    <GitHistory threadId="thread" visible onOpenCommit={() => {}} />
  ));
  await screen.findByRole("button", { name: "Subject 0 · commit-" });
  fireEvent.click(screen.getByRole("button", { name: "Git 상태 새로고침" }));
  await waitFor(() => expect(openHistory).toHaveBeenCalledTimes(2));
});
