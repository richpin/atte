import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { I18nProvider } from "shared/i18n";
import { createSignal, Show } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readImage } from "../api/files";
import { FileImagePreview, SvgPreview } from "./FileImagePreview";

vi.mock("../api/files", () => ({ readImage: vi.fn() }));
const createUrl = vi.fn();
const revokeUrl = vi.fn();
beforeEach(() => {
  let next = 0;
  createUrl.mockReset().mockImplementation(() => `blob:image-${++next}`);
  revokeUrl.mockReset();
  vi.stubGlobal("URL", {
    createObjectURL: createUrl,
    revokeObjectURL: revokeUrl,
  });
  vi.mocked(readImage).mockResolvedValue(new ArrayBuffer(4));
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("ignores late reads and releases the old image before refreshing or changing files", async () => {
  let finish!: (bytes: ArrayBuffer) => void;
  vi.mocked(readImage).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const [path, setPath] = createSignal("slow.png");
  const [revision, setRevision] = createSignal(0);
  render(() => (
    <I18nProvider>
      <FileImagePreview threadId="thread" path={path()} revision={revision()} />
    </I18nProvider>
  ));
  setPath("fast.JPG");
  await screen.findByAltText("fast.JPG");
  finish(new ArrayBuffer(20));
  await Promise.resolve();
  expect(createUrl).toHaveBeenCalledTimes(1);
  expect(createUrl.mock.calls[0][0].type).toBe("image/jpeg");
  setRevision(1);
  expect(revokeUrl).toHaveBeenCalledWith("blob:image-1");
  await waitFor(() => expect(createUrl).toHaveBeenCalledTimes(2));
  vi.mocked(readImage).mockRejectedValueOnce("missing");
  setRevision(2);
  await screen.findByRole("alert");
  expect(screen.queryByAltText("fast.JPG")).toBeNull();
  expect(revokeUrl).toHaveBeenCalledWith("blob:image-2");
});

it("drops hidden images, rereads on display and ignores reads completed after disposal", async () => {
  const [visible, setVisible] = createSignal(true);
  render(() => (
    <I18nProvider>
      <Show when={visible()}>
        <FileImagePreview threadId="thread" path="file.png" revision={0} />
      </Show>
    </I18nProvider>
  ));
  await screen.findByAltText("file.png");
  setVisible(false);
  expect(revokeUrl).toHaveBeenCalledWith("blob:image-1");
  let finish!: (bytes: ArrayBuffer) => void;
  vi.mocked(readImage).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  setVisible(true);
  expect(readImage).toHaveBeenCalledTimes(2);
  setVisible(false);
  finish(new ArrayBuffer(4));
  await Promise.resolve();
  expect(createUrl).toHaveBeenCalledTimes(1);
});

it.each([
  ["imageTooLarge", "20MiB"],
  ["unsupportedImage", "확장자가 일치"],
  ["accessDenied", "권한"],
  ["invalidPath", "작업 폴더"],
  ["missing", "이미지가 없거나"],
])("explains image read errors: %s", async (error, message) => {
  vi.mocked(readImage).mockRejectedValue(error);
  render(() => (
    <I18nProvider>
      <FileImagePreview threadId="thread" path="file.png" revision={0} />
    </I18nProvider>
  ));
  expect((await screen.findByRole("alert")).textContent).toContain(message);
  expect(createUrl).not.toHaveBeenCalled();
});

it("debounces SVG buffer changes and cancels queued updates when leaving preview", async () => {
  vi.useFakeTimers();
  const [text, setText] = createSignal("<svg/>");
  const view = render(() => (
    <I18nProvider>
      <SvgPreview path="file.svg" text={text()} />
    </I18nProvider>
  ));
  expect(createUrl).toHaveBeenCalledTimes(1);
  setText('<svg id="first"/>');
  await vi.advanceTimersByTimeAsync(100);
  setText('<svg id="second"/>');
  await vi.advanceTimersByTimeAsync(199);
  expect(createUrl).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(createUrl).toHaveBeenCalledTimes(2);
  expect(revokeUrl).toHaveBeenCalledWith("blob:image-1");
  setText('<svg id="third"/>');
  view.unmount();
  await vi.advanceTimersByTimeAsync(200);
  expect(createUrl).toHaveBeenCalledTimes(2);
  expect(revokeUrl).toHaveBeenCalledWith("blob:image-2");
});
