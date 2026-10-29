import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { readWorkingFile, type WorkingSnapshot } from "../../api/git-working";
import { WorkingChanges, workingItems } from "./WorkingChanges";

vi.mock("../../api/git-working", async (original) => ({
  ...(await original<object>()),
  readWorkingFile: vi.fn(),
}));
afterEach(cleanup);

const side = (revision: string) => ({
  oldPath: null,
  additions: 1,
  deletions: 1,
  revision,
});
const snapshot: WorkingSnapshot = {
  root: "/repo",
  branch: "main",
  head: "head",
  indexTree: "tree",
  operation: null,
  revision: "snapshot",
  latestStash: null,
  files: [
    {
      id: "61",
      path: "a.ts",
      oldPath: null,
      oldId: null,
      status: "MM",
      staged: true,
      unstaged: true,
      conflict: false,
      submodule: false,
      exists: true,
      stagedChange: side("a:staged"),
      unstagedChange: side("a:unstaged"),
    },
    {
      id: "62",
      path: "b.ts",
      oldPath: null,
      oldId: null,
      status: "??",
      staged: false,
      unstaged: true,
      conflict: false,
      submodule: false,
      exists: true,
      stagedChange: null,
      unstagedChange: side("b:unstaged"),
    },
  ],
};

it("shows separate staged and unstaged cards and selects a shift range without staging", async () => {
  vi.mocked(readWorkingFile).mockResolvedValue({ kind: "unsupported" });
  const onAction = vi.fn();
  render(() => (
    <WorkingChanges
      threadId="thread"
      visible
      snapshot={snapshot}
      disabled={false}
      refreshToken={0}
      onAction={onAction}
    />
  ));
  await waitFor(() => expect(readWorkingFile).toHaveBeenCalledTimes(3));
  expect(screen.getAllByText("a.ts")).toHaveLength(2);
  const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
  fireEvent.click(boxes[0]);
  fireEvent.click(boxes[2], { shiftKey: true });
  expect(boxes.map((box) => box.checked)).toEqual([true, true, true]);
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(boxes[1], { shiftKey: true });
  expect(boxes.map((box) => box.checked)).toEqual([true, false, false]);
});

it("keys both sides of a partially staged file separately", () => {
  expect(workingItems(snapshot.files).map((item) => item.id)).toEqual([
    "61:staged",
    "61:unstaged",
    "62:unstaged",
  ]);
  expect(workingItems(snapshot.files)[2].untracked).toBe(true);
});

it("opens the working file from either staged or unstaged changes", async () => {
  vi.mocked(readWorkingFile).mockResolvedValue({ kind: "unsupported" });
  const onOpenFile = vi.fn();
  render(() => (
    <WorkingChanges
      threadId="thread"
      visible
      snapshot={snapshot}
      disabled={false}
      refreshToken={0}
      onAction={vi.fn()}
      onOpenFile={onOpenFile}
    />
  ));
  const names = screen.getAllByRole("button", { name: "a.ts" });
  await userEvent.setup().click(names[1]);
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("/repo/a.ts");
});

it("applies the context action to selected entries of the matching side", async () => {
  vi.mocked(readWorkingFile).mockResolvedValue({ kind: "unsupported" });
  const onAction = vi.fn();
  render(() => (
    <WorkingChanges
      threadId="menu-test"
      visible
      snapshot={snapshot}
      disabled={false}
      refreshToken={0}
      onAction={onAction}
    />
  ));
  await waitFor(() => expect(readWorkingFile).toHaveBeenCalledTimes(3));
  const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
  fireEvent.click(boxes[0]);
  fireEvent.click(boxes[2], { shiftKey: true });
  fireEvent.contextMenu(screen.getAllByText("a.ts")[1]);
  const stage = await screen.findByRole("menuitem", { name: /스테이징 \(2\)/ });
  await userEvent.setup().click(stage);
  await waitFor(() =>
    expect(onAction).toHaveBeenCalledWith(
      "stage",
      expect.arrayContaining([
        expect.objectContaining({ id: "61:unstaged" }),
        expect.objectContaining({ id: "62:unstaged" }),
      ]),
    ),
  );
});

it("retains patches through collapse and refreshes only the changed side", async () => {
  vi.mocked(readWorkingFile).mockResolvedValue({ kind: "unsupported" });
  const [current, setCurrent] = createSignal(snapshot);
  render(() => (
    <WorkingChanges
      threadId="patch-test"
      visible
      snapshot={current()}
      disabled={false}
      refreshToken={0}
      onAction={() => {}}
    />
  ));
  await waitFor(() => expect(readWorkingFile).toHaveBeenCalledTimes(3));
  fireEvent.click(screen.getByRole("button", { name: "b.ts 접기" }));
  fireEvent.click(screen.getByRole("button", { name: "b.ts 펼치기" }));
  setCurrent({ ...snapshot, files: [...snapshot.files] });
  expect(readWorkingFile).toHaveBeenCalledTimes(3);
  setCurrent({
    ...snapshot,
    files: [
      snapshot.files[0],
      {
        ...snapshot.files[1],
        unstagedChange: side("b:updated"),
      },
    ],
  });
  await waitFor(() => expect(readWorkingFile).toHaveBeenCalledTimes(4));
});
