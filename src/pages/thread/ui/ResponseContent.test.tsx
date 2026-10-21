import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { I18nProvider } from "shared/i18n";
import { WebLinkProvider } from "shared/ui";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  openResponseFile,
  readResponseContent,
  saveResponseContent,
} from "../api/threads";
import type { ResponseContent } from "../model/types";
import { ResponseContentView } from "./ResponseContent";
import { ToolCall } from "./ToolCall";

vi.mock("../api/threads", () => ({
  readResponseContent: vi.fn(),
  openResponseFile: vi.fn(),
  saveResponseContent: vi.fn(),
}));
const createUrl = vi.fn();
const revokeUrl = vi.fn();
const writeClipboard = vi.fn();
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  localStorage.setItem("atte.locale", "en");
  let next = 0;
  createUrl.mockImplementation(() => `blob:content-${++next}`);
  vi.stubGlobal("URL", {
    createObjectURL: createUrl,
    revokeObjectURL: revokeUrl,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writeClipboard },
  });
  vi.mocked(readResponseContent).mockResolvedValue(new ArrayBuffer(4));
  vi.mocked(saveResponseContent).mockResolvedValue();
  vi.mocked(openResponseFile).mockResolvedValue("result.txt");
  writeClipboard.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("enlarges received images, releases hidden and replaced previews, and saves the original content", async () => {
  const [content, setContent] = createSignal<ResponseContent>({
    type: "image",
    id: "first",
    name: "result.png",
    mimeType: "image/png",
    hasData: true,
  });
  const [visible, setVisible] = createSignal(true);
  const view = render(() => (
    <I18nProvider>
      <ResponseContentView
        content={content()}
        threadId="thread"
        visible={visible()}
      />
    </I18nProvider>
  ));
  const image = await screen.findByAltText("result.png");
  fireEvent.load(image);
  fireEvent.click(screen.getByRole("button", { name: "Enlarge result.png" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
  await waitFor(() =>
    expect(saveResponseContent).toHaveBeenCalledWith(
      "thread",
      "first",
      "Save as…",
    ),
  );
  setContent({ ...content(), id: "second" });
  await waitFor(() =>
    expect(readResponseContent).toHaveBeenCalledWith("thread", "second"),
  );
  expect(revokeUrl).toHaveBeenCalledWith("blob:content-1");
  setVisible(false);
  expect(screen.queryByAltText("result.png")).toBeNull();
  view.unmount();
  expect(revokeUrl.mock.calls.length).toBe(createUrl.mock.calls.length);
});

it("shows failed reads and failed image decoding without losing the save action", async () => {
  vi.mocked(readResponseContent).mockRejectedValueOnce(
    new Error("invalidContent"),
  );
  const [content, setContent] = createSignal<ResponseContent>({
    type: "image",
    id: "bad",
    hasData: true,
    mimeType: "image/png",
  });
  render(() => (
    <I18nProvider>
      <ResponseContentView content={content()} threadId="thread" />
    </I18nProvider>
  ));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save as…" })).toBeTruthy();
  setContent({ ...content(), id: "decode-error" });
  fireEvent.error(await screen.findByAltText("Image"));
  expect(screen.getByRole("alert").textContent).toContain(
    "Preview unavailable",
  );
});

it("uses manual audio controls and removes the source when hidden", async () => {
  const [visible, setVisible] = createSignal(true);
  const view = render(() => (
    <I18nProvider>
      <ResponseContentView
        threadId="thread"
        visible={visible()}
        content={{
          type: "audio",
          id: "sound",
          mimeType: "audio/wav",
          hasData: true,
        }}
      />
    </I18nProvider>
  ));
  await waitFor(() =>
    expect(view.container.querySelector("audio")).toBeTruthy(),
  );
  const audio = view.container.querySelector("audio") as HTMLAudioElement;
  expect(audio.controls).toBe(true);
  expect(audio.autoplay).toBe(false);
  fireEvent.error(audio);
  expect(screen.getByRole("alert")).toBeTruthy();
  setVisible(false);
  expect(view.container.querySelector("audio")).toBeNull();
  expect(audio.pause).toHaveBeenCalled();
  expect(audio.getAttribute("src")).toBeNull();
  expect(revokeUrl).toHaveBeenCalledWith("blob:content-1");
});

it("displays resource text literally and does not fetch links or unsupported blobs", async () => {
  const source = "<script>unsafe()</script> **literal**";
  const view = render(() => (
    <I18nProvider>
      <ResponseContentView
        threadId="thread"
        content={{
          type: "resource",
          id: "text",
          name: "source.html",
          uri: "file:///old.html",
          text: source,
          hasData: true,
        }}
      />
      <ResponseContentView
        content={{
          type: "resource",
          id: "pdf",
          mimeType: "application/pdf",
          hasData: true,
        }}
        threadId="thread"
      />
    </I18nProvider>
  ));
  expect(view.container.querySelector("script")).toBeNull();
  expect(view.container.querySelector("details")?.open).toBe(false);
  fireEvent.click(screen.getByText("Show contents"));
  expect(screen.getByText(source).tagName).toBe("PRE");
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(source));
  expect(
    screen.getByText("Preview is not available for this content type."),
  ).toBeTruthy();
  expect(readResponseContent).not.toHaveBeenCalled();
});

it("renders compact hyperlinks and opens web and local links through their existing panels", async () => {
  const openWeb = vi.fn();
  const openFile = vi.fn();
  const [content, setContent] = createSignal<ResponseContent>({
    type: "resource_link",
    id: "web",
    name: "Report",
    uri: "https://example.com/report",
  });
  render(() => (
    <I18nProvider>
      <WebLinkProvider onOpen={openWeb}>
        <ResponseContentView
          content={content()}
          threadId="thread"
          onOpenFile={openFile}
        />
      </WebLinkProvider>
    </I18nProvider>
  ));
  expect(openWeb).not.toHaveBeenCalled();
  expect(readResponseContent).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save as…" })).toBeNull();
  expect(
    screen.getByRole("link", { name: "Report" }).getAttribute("href"),
  ).toBe("https://example.com/report");
  fireEvent.click(screen.getByRole("link", { name: "Report" }));
  await waitFor(() =>
    expect(openWeb).toHaveBeenCalledWith("https://example.com/report"),
  );
  setContent({
    type: "resource_link",
    id: "file",
    name: "result.txt",
    uri: "file:///project/result.txt",
  });
  fireEvent.click(screen.getByRole("link", { name: "result.txt" }));
  await waitFor(() => expect(openFile).toHaveBeenCalledWith("result.txt"));
  vi.mocked(openResponseFile).mockResolvedValueOnce(null);
  setContent({
    type: "resource_link",
    id: "external",
    name: "outside.pdf",
    uri: "file:///outside/report.pdf",
  });
  fireEvent.click(screen.getByRole("link", { name: "outside.pdf" }));
  await waitFor(() =>
    expect(openResponseFile).toHaveBeenCalledWith("thread", "external"),
  );
  expect(openFile).toHaveBeenCalledTimes(1);

  setContent({
    type: "resource_link",
    id: "custom",
    uri: "mcp://server/resource",
  });
  expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText("mcp://server/resource")).toBeTruthy();
});

it("keeps mixed tool results visible in order while execution details are collapsed", async () => {
  const view = render(() => (
    <I18nProvider>
      <ToolCall
        tool={{
          title: "Results",
          rawInput: { prompt: "Generate an image" },
          rawOutput: { execution: "done" },
          content: [
            { type: "content", content: { type: "text", text: "First" } },
            {
              type: "content",
              content: {
                type: "image",
                id: "screenshot",
                name: "Between.png",
                mimeType: "image/png",
                hasData: true,
              },
            },
            { type: "content", content: { type: "text", text: "Last" } },
          ],
        }}
        threadId="thread"
        active={false}
        approvalPending={false}
      />
    </I18nProvider>
  ));
  await screen.findByAltText("Between.png");
  expect(
    screen
      .getByRole("button", { name: /Results/ })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(screen.queryByText(/Generate an image/)).toBeNull();
  expect(screen.queryByText(/"execution"/)).toBeNull();
  const output = view.container.querySelectorAll(
    "pre, [data-response-content]",
  );
  expect(
    Array.from(output).map((node) =>
      node.tagName === "PRE"
        ? node.textContent
        : node.getAttribute("data-response-content"),
    ),
  ).toEqual(["First", "image", "Last"]);
  fireEvent.click(screen.getByRole("button", { name: /Results/ }));
  expect(screen.getByText(/Generate an image/)).toBeTruthy();
  expect(screen.getAllByAltText("Between.png")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /Results/ }));
  expect(screen.getByAltText("Between.png")).toBeTruthy();
  expect(revokeUrl).not.toHaveBeenCalled();
});

it("confirms copying only after clipboard success, resets feedback, and keeps failures visible", async () => {
  vi.useFakeTimers();
  let completeCopy: () => void = () => {};
  writeClipboard.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        completeCopy = resolve;
      }),
  );
  const [content, setContent] = createSignal<ResponseContent>({
    type: "resource",
    id: "first",
    text: "First",
    hasData: true,
  });
  render(() => (
    <I18nProvider>
      <ResponseContentView content={content()} threadId="thread" />
    </I18nProvider>
  ));
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  completeCopy();
  await vi.advanceTimersByTimeAsync(0);
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  await vi.advanceTimersByTimeAsync(2000);
  expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  setContent({ ...content(), id: "second", text: "Second" });
  expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  writeClipboard.mockRejectedValueOnce(new Error("Clipboard denied"));
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain(
    "Couldn’t complete the action.",
  );
});
