import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { I18nProvider } from "shared/i18n";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebBrowser } from "./WebBrowser";

const native = vi.hoisted(() => ({
  create: vi.fn(),
  action: vi.fn(() => Promise.resolve()),
  state: vi.fn(),
  setPosition: vi.fn(() => Promise.resolve()),
  setSize: vi.fn(() => Promise.resolve()),
  show: vi.fn(() => Promise.resolve()),
  hide: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
}));
vi.mock("../api/browser", () => ({
  createWebview: native.create,
  webTabAction: native.action,
  webTabState: native.state,
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(400, 120, 360, 400),
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 100, 100),
  ] as unknown as DOMRectList);
  native.create.mockResolvedValue(native);
  native.state.mockResolvedValue({
    url: "https://example.com/",
    title: "Example",
    faviconUrl: "https://example.com/favicon.ico",
    loading: false,
    canGoBack: true,
    canGoForward: false,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(initialUrl?: string) {
  const [visible, setVisible] = createSignal(true);
  const title = vi.fn();
  const favicon = vi.fn();
  const rendered = render(() => (
    <I18nProvider>
      <WebBrowser
        id="tab"
        threadId="thread"
        initialUrl={initialUrl}
        visible={visible()}
        onTitle={title}
        onFavicon={favicon}
      />
    </I18nProvider>
  ));
  return { ...rendered, setVisible, title, favicon };
}

it("waits for an address, rejects unsafe schemes and opens localhost", async () => {
  setup();
  expect(native.create).not.toHaveBeenCalled();
  const input = screen.getByRole("textbox", { name: "웹 주소" });
  fireEvent.input(input, { target: { value: "file:///tmp/test" } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  expect(screen.getByRole("alert").textContent).toContain("HTTP");
  expect(native.create).not.toHaveBeenCalled();
  fireEvent.input(input, { target: { value: "localhost:3000" } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  await waitFor(() =>
    expect(native.create).toHaveBeenCalledWith(
      "tab",
      "thread",
      "http://localhost:3000/",
    ),
  );
});

it("uses native history and keeps the webview alive while hidden", async () => {
  const { setVisible, title, unmount } = setup("https://example.com/");
  await waitFor(() => expect(native.show).toHaveBeenCalled());
  expect(title).toHaveBeenCalledWith("Example");
  expect(screen.getByRole("button", { name: "앞으로" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
  await waitFor(() =>
    expect(native.action).toHaveBeenCalledWith("tab", "back", undefined),
  );
  setVisible(false);
  await waitFor(() => expect(native.hide).toHaveBeenCalled());
  expect(native.close).not.toHaveBeenCalled();
  setVisible(true);
  await waitFor(() => expect(native.show).toHaveBeenCalledTimes(2));
  expect(native.create).toHaveBeenCalledTimes(1);
  unmount();
  await waitFor(() => expect(native.close).toHaveBeenCalledTimes(1));
});

it("hides the native surface while an application dialog is open", async () => {
  setup("https://example.com/");
  await waitFor(() => expect(native.show).toHaveBeenCalled());
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  await waitFor(() => expect(native.hide).toHaveBeenCalled());
  dialog.remove();
  await waitFor(() => expect(native.show).toHaveBeenCalledTimes(2));
});

it("closes a webview whose creation finishes after its tab is removed", async () => {
  let resolve!: (value: typeof native) => void;
  native.create.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { unmount } = setup("https://example.com/");
  unmount();
  resolve(native);
  await waitFor(() => expect(native.close).toHaveBeenCalledTimes(1));
  expect(native.show).not.toHaveBeenCalled();
});

it("allows retrying failed creation without losing the address", async () => {
  native.create.mockRejectedValueOnce(new Error("failed"));
  setup("https://example.com/");
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(native.show).toHaveBeenCalled());
  expect(native.create).toHaveBeenCalledTimes(2);
});

it("updates the address after native focus moves to another webview", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  native.state.mockResolvedValue({
    url: "https://example.com/redirected",
    title: "Redirected",
    loading: false,
    canGoBack: true,
    canGoForward: false,
  });
  setup("https://example.com/");
  screen.getByRole("textbox", { name: "웹 주소" }).focus();
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "웹 주소" })).toHaveProperty(
      "value",
      "https://example.com/redirected",
    ),
  );
});

it("blocks address submission until native creation finishes", async () => {
  let resolve!: (value: typeof native) => void;
  native.create.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  setup("https://example.com/");
  const input = screen.getByRole("textbox", { name: "웹 주소" });
  expect(input).toHaveProperty("disabled", true);
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  expect(native.create).toHaveBeenCalledTimes(1);
  resolve(native);
  await waitFor(() => expect(input).toHaveProperty("disabled", false));
  fireEvent.input(input, { target: { value: "https://example.com/next" } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  await waitFor(() =>
    expect(native.action).toHaveBeenCalledWith(
      "tab",
      "navigate",
      "https://example.com/next",
    ),
  );
});

it("does not scan application overlays for retained hidden tabs", async () => {
  const { setVisible } = setup("https://example.com/");
  await waitFor(() => expect(native.show).toHaveBeenCalled());
  setVisible(false);
  await waitFor(() => expect(native.hide).toHaveBeenCalled());
  const scan = vi.spyOn(document, "querySelectorAll");
  const changed = document.createElement("div");
  document.body.append(changed);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(
    scan.mock.calls.some(([selector]) => selector.includes('[role="dialog"]')),
  ).toBe(false);
  changed.remove();
});

it("updates the favicon from page state and clears it when navigating", async () => {
  const { favicon } = setup("https://example.com/");
  await waitFor(() =>
    expect(favicon).toHaveBeenLastCalledWith("https://example.com/favicon.ico"),
  );
  const input = screen.getByRole("textbox", { name: "웹 주소" });
  fireEvent.input(input, { target: { value: "https://example.com/next" } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  expect(favicon).toHaveBeenLastCalledWith(null);
  native.state.mockResolvedValue({
    url: "https://example.org/redirected",
    title: "Redirected",
    faviconUrl: "https://example.org/icon.svg",
    loading: false,
    canGoBack: true,
    canGoForward: false,
  });
  await waitFor(() =>
    expect(favicon).toHaveBeenLastCalledWith("https://example.org/icon.svg"),
  );
});
