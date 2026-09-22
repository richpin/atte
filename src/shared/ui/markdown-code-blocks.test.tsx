import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { Markdown } from "./markdown";

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  localStorage.setItem("atte.locale", "en");
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  localStorage.removeItem("atte.locale");
  vi.useRealTimers();
});

function renderCode(source: string, streaming = true) {
  return render(() => (
    <I18nProvider>
      <Markdown source={source} variant="agent" streaming={streaming} />
    </I18nProvider>
  ));
}

it("renders fenced code immediately with normalized known languages and local overflow", () => {
  const source = `\`\`\`ts
const longValue = "${"x".repeat(120)}";
\`\`\`

\`\`\`unknown-runtime
plain();
\`\`\``;
  const { container } = renderCode(source);

  const blocks = container.querySelectorAll<HTMLElement>(
    "[data-markdown-code-block]",
  );
  expect(blocks).toHaveLength(2);
  expect(blocks[0]?.querySelector("[data-code-language]")?.textContent).toBe(
    "TypeScript",
  );
  expect(blocks[1]?.querySelector("[data-code-language]")).toBeNull();
  expect(blocks[1]?.querySelector("code")?.textContent).toBe("plain();");
  expect(blocks[0]?.classList).toContain("max-w-full");
  expect(blocks[0]?.querySelector("pre")?.classList).toContain(
    "overflow-x-auto",
  );
});

it("renders an open fence as copyable plain code", async () => {
  const exactSource = "const spacing = 'kept';  \n\treturn spacing;";
  const { container } = renderCode(`\`\`\`javascript\n${exactSource}`);

  expect(container.querySelector("pre code")?.textContent).toBe(exactSource);
  await fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  expect(writeText).toHaveBeenCalledWith(exactSource);
});

it("acknowledges successful copy accessibly for two seconds and safely restarts feedback", async () => {
  vi.useFakeTimers();
  const { unmount } = renderCode("```rust\nfn main() {}\n```", false);
  const button = screen.getByRole("button", { name: "Copy code" });

  fireEvent.click(button);
  await Promise.resolve();
  expect(screen.getByRole("button", { name: "Copied code" }).textContent).toBe(
    "Copied",
  );
  expect(screen.getByRole("status").textContent).toBe(
    "Code copied to clipboard.",
  );

  vi.advanceTimersByTime(1_000);
  fireEvent.click(button);
  await Promise.resolve();
  vi.advanceTimersByTime(1_100);
  expect(screen.getByRole("button", { name: "Copied code" })).toBeTruthy();

  vi.advanceTimersByTime(900);
  expect(screen.getByRole("button", { name: "Copy code" }).textContent).toBe(
    "Copy",
  );

  fireEvent.click(button);
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("shows truthful feedback only inside the code block when copying fails", async () => {
  writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
  const { container } = renderCode(
    "```python\nprint('one')\n```\n\n```\nplain\n```",
  );
  const buttons = screen.getAllByRole("button", { name: "Copy code" });

  fireEvent.click(buttons[0] as HTMLButtonElement);
  await Promise.resolve();

  expect(screen.queryByRole("button", { name: "Copied code" })).toBeNull();
  const feedback = screen.getByText("Couldn’t copy code.");
  expect(feedback.classList).not.toContain("sr-only");
  expect(feedback.closest("[data-markdown-code-block]")).toBe(
    container.querySelectorAll("[data-markdown-code-block]")[0],
  );
  expect(
    container.querySelectorAll("[data-code-copy-feedback]")[1]?.textContent,
  ).toBe("");
});

it("ignores clipboard results that settle after the component is removed", async () => {
  vi.useFakeTimers();
  let finishCopy: (() => void) | undefined;
  writeText.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishCopy = resolve;
      }),
  );
  const { unmount } = renderCode('```go\nfmt.Println("done")\n```');

  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  unmount();
  finishCopy?.();
  await Promise.resolve();

  expect(vi.getTimerCount()).toBe(0);
});
