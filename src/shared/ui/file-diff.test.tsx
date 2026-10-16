import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareFileChanges } from "../diff";
import { FileDiff } from "./file-diff";
import { createFileDiffRenderer } from "./file-diff-renderer";

vi.mock("./file-diff-renderer", () => ({ createFileDiffRenderer: vi.fn() }));
const controller = () => ({
  setTheme: vi.fn(),
  setExpanded: vi.fn(),
  refresh: vi.fn(),
  dispose: vi.fn(),
});
beforeEach(() => {
  vi.mocked(createFileDiffRenderer).mockReset();
});
afterEach(cleanup);

it("exposes an explicit full-context toggle for files with hidden source", async () => {
  const instance = controller();
  vi.mocked(createFileDiffRenderer).mockResolvedValue(instance);
  const lines = Array.from({ length: 120 }, (_, index) => `line ${index}\n`);
  const before = lines.join("");
  lines[59] = "changed\n";
  const [file] = await prepareFileChanges([
    { path: "context.txt", comparisons: [{ before, after: lines.join("") }] },
  ]);
  const root = document.createElement("div");
  render(() => (
    <FileDiff
      comparison={file.comparisons[0]}
      scrollRoot={() => root}
      scrollContent={() => root}
      visible
    />
  ));
  const toggle = await screen.findByRole("button", { name: "전체 코드 보기" });
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  fireEvent.click(toggle);
  expect(instance.setExpanded).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("button", { name: "변경 부분만 보기" })).toBeTruthy();
  fireEvent.click(toggle);
  expect(instance.setExpanded).toHaveBeenLastCalledWith(false);
});

it("omits context controls and repeated notices when there is no additional source", async () => {
  vi.mocked(createFileDiffRenderer).mockResolvedValue(controller());
  const [file] = await prepareFileChanges([
    { path: "short.txt", comparisons: [{ before: "old", after: "new" }] },
  ]);
  const root = document.createElement("div");
  render(() => (
    <FileDiff
      comparison={file.comparisons[0]}
      scrollRoot={() => root}
      scrollContent={() => root}
      visible
    />
  ));
  expect(screen.queryByRole("button", { name: "전체 코드 보기" })).toBeNull();
  expect(
    screen.queryByText("전달받은 원문이 모두 표시되어 있습니다."),
  ).toBeNull();
});

it("refreshes on reveal without recreating the viewer and disposes on unmount", async () => {
  const instance = controller();
  vi.mocked(createFileDiffRenderer).mockResolvedValue(instance);
  const [file] = await prepareFileChanges([
    { path: "a.ts", comparisons: [{ before: "old", after: "new" }] },
  ]);
  const [visible, setVisible] = createSignal(true);
  const root = document.createElement("div");
  const result = render(() => (
    <FileDiff
      comparison={file.comparisons[0]}
      scrollRoot={() => root}
      scrollContent={() => root}
      visible={visible()}
    />
  ));
  await waitFor(() => expect(instance.refresh).toHaveBeenCalledTimes(1));
  setVisible(false);
  setVisible(true);
  expect(instance.refresh).toHaveBeenCalledTimes(2);
  expect(createFileDiffRenderer).toHaveBeenCalledTimes(1);
  result.unmount();
  expect(instance.dispose).toHaveBeenCalledTimes(1);
});

it("disposes a viewer whose asynchronous initialization finishes after unmount", async () => {
  const instance = controller();
  let finish!: (value: typeof instance) => void;
  vi.mocked(createFileDiffRenderer).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const [file] = await prepareFileChanges([
    { path: "a.ts", comparisons: [{ before: "old", after: "new" }] },
  ]);
  const root = document.createElement("div");
  const result = render(() => (
    <FileDiff
      comparison={file.comparisons[0]}
      scrollRoot={() => root}
      scrollContent={() => root}
      visible
    />
  ));
  await waitFor(() => expect(createFileDiffRenderer).toHaveBeenCalled());
  result.unmount();
  finish(instance);
  await waitFor(() => expect(instance.dispose).toHaveBeenCalledTimes(1));
});

it("keeps the source visible as text if rendering fails", async () => {
  vi.mocked(createFileDiffRenderer).mockRejectedValue(
    new Error("renderer failed"),
  );
  const [file] = await prepareFileChanges([
    {
      path: "a.ts",
      comparisons: [{ before: "<old>", after: "<script>new</script>" }],
    },
  ]);
  const root = document.createElement("div");
  const result = render(() => (
    <FileDiff
      comparison={file.comparisons[0]}
      scrollRoot={() => root}
      scrollContent={() => root}
      visible
    />
  ));
  await screen.findByRole("alert");
  expect(result.container.querySelector("pre")?.textContent).toContain(
    "<script>new</script>",
  );
  expect(result.container.querySelector("script")).toBeNull();
});
