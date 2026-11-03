import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "shared/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppUpdates } from "../model/updates";
import { AppUpdateSettings } from "./AppUpdateSettings";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke,
  Channel: class {
    onmessage = () => {};
  },
}));
const available = {
  supported: true,
  currentVersion: "0.1.0",
  version: "0.1.1",
  notes: "Release notes",
};
function mount() {
  render(() => {
    const updates = createAppUpdates();
    return (
      <I18nProvider>
        <AppUpdateSettings updates={updates} />
      </I18nProvider>
    );
  });
}
afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("atte.locale", "en");
  invoke.mockReset();
  invoke.mockResolvedValue(available);
});
describe("application updates", () => {
  it("checks on launch and installs only on request, then restarts only on request", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Release notes");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "check_app_update",
    ]);
    await user.click(
      screen.getByRole("button", { name: "Download and install" }),
    );
    await screen.findByRole("button", { name: "Restart Atte" });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "check_app_update",
      "install_app_update",
    ]);
    await user.click(screen.getByRole("button", { name: "Restart Atte" }));
    expect(invoke).toHaveBeenLastCalledWith("restart_after_update");
  });
  it("allows retry after installation fails without offering restart", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((command) =>
      command === "install_app_update"
        ? Promise.reject(new Error("invalid signature"))
        : Promise.resolve(available),
    );
    mount();
    await screen.findByText("Release notes");
    await user.click(
      screen.getByRole("button", { name: "Download and install" }),
    );
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Restart Atte" })).toBeNull();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Download and install" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
  });
  it("disables updates in development builds", async () => {
    invoke.mockResolvedValue({
      ...available,
      supported: false,
      version: null,
      notes: null,
    });
    mount();
    await screen.findByText(/Updates are available in signed macOS releases/);
    expect(
      screen.queryByRole("button", { name: "Download and install" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Check for updates" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
