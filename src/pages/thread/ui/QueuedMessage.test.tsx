import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { I18nProvider } from "shared/i18n";
import { createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { QueuedMessage } from "./QueuedMessage";

afterEach(cleanup);

it("keeps messages on one line in a ten-row scroll region", () => {
  render(() => (
    <I18nProvider>
      <QueuedMessage
        messages={Array.from({ length: 11 }, (_, index) => ({
          id: `queued-${index + 1}`,
          text: `Queued message ${index + 1}`,
        }))}
        onDelete={async () => {}}
      />
    </I18nProvider>
  ));

  const queue = screen.getByRole("list", { name: "대기 메시지" });
  expect(queue.classList).toContain("max-h-thread-queue");
  expect(queue.classList).toContain("min-h-thread-queue-row");
  expect(queue.classList).toContain("overflow-y-auto");
  expect(queue.classList).toContain("overscroll-contain");
  expect(within(queue).getAllByRole("listitem")).toHaveLength(11);
  expect(screen.queryByRole("button", { name: "Queued message 1" })).toBeNull();
  expect(screen.getByText("Queued message 1").classList).toContain("truncate");
});

it("appends new messages without following the bottom", () => {
  const [messages, setMessages] = createSignal(
    Array.from({ length: 11 }, (_, index) => ({
      id: `queued-${index + 1}`,
      text: `Queued message ${index + 1}`,
    })),
  );
  render(() => (
    <I18nProvider>
      <QueuedMessage messages={messages()} onDelete={async () => {}} />
    </I18nProvider>
  ));
  const queue = screen.getByRole("list", { name: "대기 메시지" });
  queue.scrollTop = 48;

  setMessages((current) => [
    ...current,
    { id: "queued-12", text: "Queued message 12" },
  ]);

  expect(queue.scrollTop).toBe(48);
  expect(within(queue).getAllByRole("listitem").at(-1)?.textContent).toContain(
    "Queued message 12",
  );
});
