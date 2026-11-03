import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "shared/i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAppUpdates } from "../model/updates";
import { AppUpdateNotice } from "./AppUpdateNotice";
import { AppUpdateSettings } from "./AppUpdateSettings";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke,
  Channel: class {
    onmessage = (_progress: unknown) => {};
  },
}));

const available = {
  supported: true,
  currentVersion: "0.1.0",
  version: "0.1.1",
  notes: null,
};

function mount(withSettings = false) {
  render(() => {
    const updates = createAppUpdates();
    return (
      <I18nProvider>
        <AppUpdateNotice updates={updates} />
        {withSettings && <AppUpdateSettings updates={updates} />}
      </I18nProvider>
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("atte.locale", "en");
  invoke.mockReset();
  invoke.mockImplementation((command) =>
    Promise.resolve(command === "check_app_update" ? available : undefined),
  );
});
afterEach(cleanup);

it("shows an actionable bottom-right notice and stays dismissed for this mount", async () => {
  const user = userEvent.setup();
  mount(true);
  const notice = await screen.findByRole("status", { name: "App updates" });
  expect(notice.className).toContain("right-4 bottom-4");
  expect(notice.textContent).toContain("Version 0.1.1 is available.");
  expect(invoke).toHaveBeenCalledTimes(1);
  await user.click(
    screen.getByRole("button", { name: "Dismiss notification" }),
  );
  expect(screen.queryByRole("status", { name: "App updates" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Download and install" }),
  ).toBeTruthy();
  cleanup();
  mount();
  expect(
    await screen.findByRole("status", { name: "App updates" }),
  ).toBeTruthy();
});

it("shows download progress, failure and retry, then offers restart", async () => {
  const user = userEvent.setup();
  let rejectInstall!: (error: Error) => void;
  let resolveInstall!: () => void;
  invoke.mockImplementation((command) => {
    if (command === "check_app_update") return Promise.resolve(available);
    if (command === "install_app_update") {
      return new Promise<void>((resolve, reject) => {
        resolveInstall = resolve;
        rejectInstall = reject;
      });
    }
    return Promise.resolve();
  });
  mount();
  await screen.findByRole("status", { name: "App updates" });
  await user.click(
    screen.getByRole("button", { name: "Download and install" }),
  );
  const installCall = invoke.mock.calls.find(
    ([command]) => command === "install_app_update",
  );
  const channel = installCall?.[1].progress as {
    onmessage: (progress: { downloaded: number; total: number }) => void;
  };
  channel.onmessage({ downloaded: 50, total: 100 });
  expect(screen.getByText("Downloading… 50%")).toBeTruthy();
  rejectInstall(new Error("network"));
  await screen.findByRole("alert");
  await user.click(
    screen.getByRole("button", { name: "Download and install" }),
  );
  resolveInstall();
  await screen.findByRole("button", { name: "Restart Atte" });
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Restart Atte" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("restart_after_update"),
  );
});

it("does not show an update notice when no new version is available", async () => {
  invoke.mockResolvedValueOnce({ ...available, version: null });
  mount();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("check_app_update"));
  expect(screen.queryByRole("status", { name: "App updates" })).toBeNull();
});
