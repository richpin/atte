import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
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

it("loads only the selected file and identifies the first-parent comparison", async () => {
  vi.mocked(readCommit).mockResolvedValue(
    details([file("a.bin"), file("b.bin")]),
  );
  render(() => <CommitReview threadId="thread" oid="merge" visible />);
  await screen.findByText("첫 부모 기준");
  await waitFor(() =>
    expect(readCommitFile).toHaveBeenCalledWith("thread", "merge", 0),
  );
  expect(readCommitFile).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "b.bin · M" }));
  await waitFor(() =>
    expect(readCommitFile).toHaveBeenLastCalledWith("thread", "merge", 1),
  );
  expect(readCommitFile).toHaveBeenCalledTimes(2);
  await screen.findByText(
    "바이너리 파일이 변경되었습니다. 텍스트 diff를 제공하지 않습니다.",
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
