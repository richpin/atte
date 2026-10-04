import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { I18nProvider } from "shared/i18n";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ToolCall as ToolData } from "../model/types";
import { ToolCall } from "./ToolCall";

beforeEach(() => localStorage.setItem("atte.locale", "en"));
afterEach(cleanup);

it("keeps details expanded as a tool finishes and displays output literally", async () => {
  const [tool, setTool] = createSignal<ToolData>({
    title: "Run tests",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "pnpm test" },
    locations: [{ path: "/project/test.ts", line: 3 }],
  });
  render(() => (
    <I18nProvider>
      <ToolCall tool={tool()} active approvalPending={false} />
    </I18nProvider>
  ));
  expect(screen.queryByText(/"command"/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Run tests/ }));
  expect(screen.getByText(/"command": "pnpm test"/)).toBeTruthy();
  expect(screen.getByText("/project/test.ts:3")).toBeTruthy();
  setTool({
    ...tool(),
    status: "completed",
    content: [
      {
        type: "content",
        content: { type: "text", text: "**passed** <script>unsafe</script>" },
      },
    ],
  });
  expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Completed")).toBeTruthy();
  expect(screen.getByText("**passed** <script>unsafe</script>").tagName).toBe(
    "PRE",
  );
  expect(document.querySelector("script")).toBeNull();
});

it("distinguishes approval, interrupted and unknown completion without guessing success", () => {
  const [active, setActive] = createSignal(true);
  const [approval, setApproval] = createSignal(false);
  const [interrupted, setInterrupted] = createSignal(false);
  render(() => (
    <I18nProvider>
      <ToolCall
        tool={{}}
        active={active()}
        approvalPending={approval()}
        interrupted={interrupted()}
      />
    </I18nProvider>
  ));
  expect(screen.getByText("Waiting")).toBeTruthy();
  setApproval(true);
  expect(screen.getByText("Approval required")).toBeTruthy();
  setApproval(false);
  setActive(false);
  expect(screen.getByText("Completion unconfirmed")).toBeTruthy();
  setInterrupted(true);
  expect(screen.getByText("Interrupted")).toBeTruthy();
});

it("shows failure details only when expanded and marks unsupported result types", () => {
  render(() => (
    <I18nProvider>
      <ToolCall
        tool={{
          title: "Edit",
          status: "failed",
          rawOutput: "Permission denied\nTry again",
          content: [
            { type: "diff", path: "/project/file.ts" },
            { type: "terminal", terminalId: "term-1" },
          ],
        }}
        active={false}
        approvalPending={false}
      />
    </I18nProvider>
  ));
  expect(screen.getByText("Failed")).toBeTruthy();
  expect(screen.queryByText(/Permission denied/)).toBeNull();
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText("Permission denied Try again")).toBeTruthy();
  expect(screen.getByText("File changes: /project/file.ts")).toBeTruthy();
  expect(
    screen.getByText("Terminal output (preview unavailable)"),
  ).toBeTruthy();
});
