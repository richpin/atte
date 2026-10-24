import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type ChangedFile,
  type CommitDetails,
  readCommit,
  readCommitFile,
} from "../../api/git-history";
import { CommitReview } from "./CommitReview";

vi.mock("../../api/git-history", () => ({
  readCommit: vi.fn(),
  readCommitFile: vi.fn(),
}));
const file = (path: string): ChangedFile => ({
  path,
  additions: 2,
  deletions: 1,
  oldPath: null,
  change: "M",
  oldMode: "100644",
  newMode: "100644",
  oldOid: "old",
  newOid: "new",
});
const details = (files: ChangedFile[] = []): CommitDetails => ({
  commit: {
    oid: "merge",
    parents: ["first", "second"],
    subject: "Merge feature",
    author: "Author",
    timestamp: 1700000000,
  },
  body: "",
  base: "first",
  boundary: false,
  files,
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readCommitFile).mockResolvedValue({ kind: "binary" });
});
afterEach(cleanup);

it("shows all files expanded with totals and retains patches after collapsing", async () => {
  vi.mocked(readCommit).mockResolvedValue(
    details([
      file("a.bin"),
      { ...file("src/b.bin"), additions: null, deletions: null },
    ]),
  );
  render(() => <CommitReview threadId="thread" oid="merge" visible />);
  await screen.findByText("첫 부모 기준");
  await waitFor(() => expect(readCommitFile).toHaveBeenCalledTimes(2));
  expect(readCommitFile).toHaveBeenCalledWith("thread", "merge", 0);
  expect(readCommitFile).toHaveBeenCalledWith("thread", "merge", 1);
  expect(
    screen.getByRole("img", { name: "텍스트 줄 변경: 2줄 추가, 1줄 삭제" }),
  ).toBeTruthy();
  expect(screen.getByText("src/")).toBeTruthy();
  expect(screen.getAllByText("—")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "전체 접기" }));
  expect(
    screen
      .getByRole("button", { name: "a.bin 펼치기" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "전체 펼치기" }));
  expect(
    screen
      .getByRole("button", { name: "src/b.bin 접기" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(readCommitFile).toHaveBeenCalledTimes(2);
});

it("colors Git change codes by action", async () => {
  vi.mocked(readCommit).mockResolvedValue(
    details(
      ["A", "M", "D", "R100", "C100", "T"].map((change) => ({
        ...file(`${change}.txt`),
        change,
      })),
    ),
  );
  render(() => <CommitReview threadId="thread" oid="merge" visible />);
  await screen.findByText("A.txt");
  for (const [change, color] of [
    ["A", "text-response-success"],
    ["M", "text-response-warning"],
    ["D", "text-danger"],
    ["R100", "text-response-info"],
    ["C100", "text-response-info"],
    ["T", "text-response-warning"],
  ]) {
    expect(screen.getByText(change).classList.contains(color)).toBe(true);
  }
});

it("opens a changed file without repeating paths, modes, or object IDs above the diff", async () => {
  vi.mocked(readCommit).mockResolvedValue(
    details([
      {
        ...file("src/renamed.ts"),
        oldPath: "src/old.ts",
        oldMode: "100644",
        newMode: "100755",
        oldOid: "before-oid",
        newOid: "after-oid",
      },
    ]),
  );
  render(() => <CommitReview threadId="thread" oid="merge" visible />);
  await screen.findByRole("button", { name: "src/renamed.ts 접기" });
  await screen.findByText(
    "바이너리 파일이 변경되었습니다. 텍스트 diff를 제공하지 않습니다.",
  );
  expect(screen.queryByText("src/old.ts → src/renamed.ts")).toBeNull();
  expect(screen.queryByText("100644 → 100755")).toBeNull();
  expect(screen.queryByText("before-oid → after-oid")).toBeNull();
});

it("isolates a failed file and retries it without reloading other files", async () => {
  vi.mocked(readCommit).mockResolvedValue(
    details([file("a.bin"), file("b.bin")]),
  );
  vi.mocked(readCommitFile)
    .mockRejectedValueOnce(new Error("missing blob"))
    .mockResolvedValue({ kind: "binary" });
  render(() => <CommitReview threadId="thread" oid="merge" visible />);
  await screen.findByRole("alert");
  await screen.findByText(
    "바이너리 파일이 변경되었습니다. 텍스트 diff를 제공하지 않습니다.",
  );
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(readCommitFile).toHaveBeenCalledTimes(3);
  expect(readCommitFile).toHaveBeenLastCalledWith("thread", "merge", 0);
});

it("retains expansion across visibility changes and resets for a new commit", async () => {
  vi.mocked(readCommit).mockImplementation(async (_thread, oid) => ({
    ...details([file("a.bin")]),
    commit: { ...details().commit, oid },
  }));
  const [oid, setOid] = createSignal("first");
  const [visible, setVisible] = createSignal(true);
  render(() => (
    <CommitReview threadId="thread" oid={oid()} visible={visible()} />
  ));
  fireEvent.click(await screen.findByRole("button", { name: "a.bin 접기" }));
  setVisible(false);
  setVisible(true);
  expect(screen.getByRole("button", { name: "a.bin 펼치기" })).toBeTruthy();
  setOid("second");
  await screen.findByRole("button", { name: "a.bin 접기" });
  await waitFor(() =>
    expect(readCommitFile).toHaveBeenLastCalledWith("thread", "second", 0),
  );
});

it("handles a failed commit query inside the tab and retries successfully", async () => {
  vi.mocked(readCommit)
    .mockRejectedValueOnce({ kind: "git", message: "missing object" })
    .mockResolvedValueOnce(details());
  render(() => <CommitReview threadId="thread" oid="merge" visible />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await screen.findByText("파일 변경사항이 없는 커밋입니다.");
  expect(readCommit).toHaveBeenCalledTimes(2);
});
it("explains missing shallow parents instead of showing an empty commit", async () => {
  vi.mocked(readCommit).mockResolvedValue({ ...details(), boundary: true });
  render(() => <CommitReview threadId="thread" oid="merge" visible />);
  await screen.findByText(
    "Shallow clone에 이 커밋의 부모가 없어 변경사항을 표시할 수 없습니다.",
  );
  expect(screen.queryByText("파일 변경사항이 없는 커밋입니다.")).toBeNull();
  expect(readCommitFile).not.toHaveBeenCalled();
});
