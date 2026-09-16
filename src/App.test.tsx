import { cleanup, render, screen } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(cleanup);

it("submits the current name and updates the greeting without remounting", async () => {
  const user = userEvent.setup();
  vi.mocked(invoke)
    .mockResolvedValueOnce("Hello, Atte!")
    .mockResolvedValueOnce("Hello, Solid!");
  render(() => <App />);

  const input = screen.getByRole("textbox");
  const submit = screen.getByRole("button", { name: "Greet" });
  await user.type(input, "Atte");
  await user.click(submit);

  expect(invoke).toHaveBeenLastCalledWith("greet", { name: "Atte" });
  expect(await screen.findByText("Hello, Atte!")).toBeTruthy();

  await user.clear(input);
  await user.type(input, "Solid");
  await user.click(submit);

  expect(invoke).toHaveBeenLastCalledWith("greet", { name: "Solid" });
  expect(await screen.findByText("Hello, Solid!")).toBeTruthy();
  expect(screen.queryByText("Hello, Atte!")).toBeNull();
});
