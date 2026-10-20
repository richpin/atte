import { createRoot } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closeHistory,
  type GitCommit,
  type GitHistorySnapshot,
  openHistory,
  readPage,
} from "../api/git-history";
import { createHistoryModel } from "./git-history";

vi.mock("../api/git-history", () => ({
  openHistory: vi.fn(),
  readPage: vi.fn(),
  closeHistory: vi.fn(),
}));
const disposers: (() => void)[] = [];
const commit = (oid: string, parents: string[] = []): GitCommit => ({
  oid,
  parents,
  subject: oid,
  author: "test",
  timestamp: 0,
});
const snapshot = (
  oid = "c",
  cursor: string | null = "cursor",
): GitHistorySnapshot => ({
  repository: { root: "/repo", head: oid, references: [], shallow: false },
  page: { commits: [commit(oid, ["parent"])], cursor },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  return createRoot((dispose) => {
    disposers.push(dispose);
    return createHistoryModel("thread");
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(closeHistory).mockResolvedValue();
  vi.mocked(openHistory).mockResolvedValue(snapshot());
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

it("loads incrementally, prevents overlapping pages, and releases cursors on disposal", async () => {
  const model = setup();
  await model.refresh();
  const original = model.rows()[0];
  const next = deferred<{ commits: GitCommit[]; cursor: string | null }>();
  vi.mocked(readPage).mockReturnValue(next.promise);
  const request = model.loadMore();
  await model.loadMore();
  expect(readPage).toHaveBeenCalledTimes(1);
  next.resolve({ commits: [commit("parent")], cursor: "next" });
  await request;
  expect(model.rows()).toHaveLength(2);
  expect(model.rows()[0]).toBe(original);
  disposers.pop()?.();
  expect(closeHistory).toHaveBeenCalledWith("thread", "next");
});
it("ignores stale branch queries and closes their late cursors", async () => {
  const old = deferred<GitHistorySnapshot>();
  vi.mocked(openHistory)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(snapshot("new", "new-cursor"));
  const model = setup();
  const first = model.refresh();
  await model.refresh("refs/heads/feature");
  old.resolve(snapshot("old", "old-cursor"));
  await first;
  expect(model.rows()[0].commit.oid).toBe("new");
  expect(model.reference()).toBe("refs/heads/feature");
  expect(closeHistory).toHaveBeenCalledWith("thread", "old-cursor");
});
it("ignores an old page after refresh without appending it to the new graph", async () => {
  const next = deferred<{ commits: GitCommit[]; cursor: null }>();
  const model = setup();
  await model.refresh();
  vi.mocked(readPage).mockReturnValue(next.promise);
  const page = model.loadMore();
  vi.mocked(openHistory).mockResolvedValueOnce(snapshot("refreshed", null));
  await model.refresh();
  next.resolve({ commits: [commit("stale")], cursor: null });
  await page;
  expect(model.rows().map((row) => row.commit.oid)).toEqual(["refreshed"]);
});
it("releases a query that completes after its tab was closed", async () => {
  const late = deferred<GitHistorySnapshot>();
  vi.mocked(openHistory).mockReturnValue(late.promise);
  const model = setup();
  const request = model.refresh();
  disposers.pop()?.();
  late.resolve(snapshot());
  await request;
  expect(closeHistory).toHaveBeenCalledWith("thread", "cursor");
  expect(model.rows()).toEqual([]);
});
it("keeps loaded history on a page failure and permits an explicit refresh", async () => {
  const model = setup();
  await model.refresh();
  vi.mocked(readPage).mockRejectedValue(new Error("failed"));
  await model.loadMore();
  expect(model.rows()).toHaveLength(1);
  expect(model.error()).toBeTruthy();
  vi.mocked(openHistory).mockResolvedValueOnce(snapshot("fresh", null));
  await model.refresh();
  expect(model.error()).toBeUndefined();
  expect(model.rows()[0].commit.oid).toBe("fresh");
});
