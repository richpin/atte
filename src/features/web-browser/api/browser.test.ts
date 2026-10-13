import { beforeEach, expect, it, vi } from "vitest";
import { createWebview, listenForWebTabs } from "./browser";

const { listen, invoke, getByLabel } = vi.hoisted(() => ({
  listen: vi.fn(),
  invoke: vi.fn(),
  getByLabel: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webview", () => ({ Webview: { getByLabel } }));
beforeEach(() => {
  invoke.mockReset();
  getByLabel.mockReset();
});
vi.mock("@tauri-apps/api/event", () => ({ listen }));

it("receives popup requests targeted to the main webview", async () => {
  const stop = vi.fn();
  listen.mockResolvedValue(stop);
  const open = vi.fn();
  const unlisten = await listenForWebTabs(open);
  const [event, receive, options] = listen.mock.calls[0];
  expect(event).toBe("browser-open");
  expect(options).toEqual({ target: { kind: "Webview", label: "main" } });
  receive({ payload: { threadId: "thread", url: "https://example.com" } });
  expect(open).toHaveBeenCalledWith("thread", "https://example.com");
  unlisten();
  expect(stop).toHaveBeenCalled();
});

it("closes the native child if obtaining its frontend handle fails, so retry can create it again", async () => {
  invoke.mockResolvedValue(undefined);
  getByLabel.mockRejectedValueOnce(new Error("lookup failed"));
  await expect(
    createWebview("tab", "thread", "https://example.com/"),
  ).rejects.toThrow("lookup failed");
  expect(invoke).toHaveBeenLastCalledWith("web_tab_action", {
    id: "tab",
    action: "close",
    url: undefined,
  });
  const view = { close: vi.fn() };
  getByLabel.mockResolvedValue(view);
  await expect(
    createWebview("tab", "thread", "https://example.com/"),
  ).resolves.toBe(view);
});

it("does not close an existing child when native creation itself is rejected", async () => {
  invoke.mockRejectedValue(new Error("already exists"));
  await expect(
    createWebview("tab", "thread", "https://example.com/"),
  ).rejects.toThrow("already exists");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(getByLabel).not.toHaveBeenCalled();
});
