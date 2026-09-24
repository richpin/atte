import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
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
          attachments: [],
          status: "pending" as const,
        }))}
        disabled={false}
        onRetry={async () => {}}
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
      attachments: [],
      status: "pending" as const,
    })),
  );
  render(() => (
    <I18nProvider>
      <QueuedMessage
        messages={messages()}
        disabled={false}
        onRetry={async () => {}}
        onDelete={async () => {}}
      />
    </I18nProvider>
  ));
  const queue = screen.getByRole("list", { name: "대기 메시지" });
  queue.scrollTop = 48;

  setMessages((current) => [
    ...current,
    {
      id: "queued-12",
      text: "Queued message 12",
      attachments: [],
      status: "pending",
    },
  ]);

  expect(queue.scrollTop).toBe(48);
  expect(within(queue).getAllByRole("listitem").at(-1)?.textContent).toContain(
    "Queued message 12",
  );
});

it("offers retry and delete for a failed queued input", async () => {
  let retried: string | undefined;
  let deleted: string | undefined;
  render(() => (
    <I18nProvider>
      <QueuedMessage
        messages={[
          {
            id: "failed",
            text: "retry me",
            attachments: [],
            status: "failed",
          },
        ]}
        disabled={false}
        onRetry={async (id) => {
          retried = id;
        }}
        onDelete={async (id) => {
          deleted = id;
        }}
      />
    </I18nProvider>
  ));

  const retry = screen.getByRole("button", {
    name: /(?:Retry queued message|다시 시도): retry me/,
  });
  fireEvent.click(retry);
  expect(retried).toBe("failed");
  await waitFor(() => expect(retry).toHaveProperty("disabled", false));
  fireEvent.click(
    screen.getByRole("button", {
      name: /(?:Delete queued message|삭제): retry me/,
    }),
  );
  expect(deleted).toBe("failed");
});

it("shows attachment-only queued input as read-only chips", () => {
  render(() => (
    <I18nProvider>
      <QueuedMessage
        messages={[
          {
            id: "attachments-only",
            text: "",
            attachments: [
              { id: "one", name: "one.png", uri: "file:///secret/one.png" },
              { id: "two", name: "two.mp3", uri: "file:///secret/two.mp3" },
            ],
            status: "pending",
          },
        ]}
        disabled={false}
        onRetry={async () => {}}
        onDelete={async () => {}}
      />
    </I18nProvider>
  ));

  expect(screen.getByText("one.png")).toBeTruthy();
  expect(screen.getByText("two.mp3")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /Remove attachment/ }),
  ).toBeNull();
  expect(screen.queryByText(/secret/)).toBeNull();
  expect(
    screen.getByRole("button", {
      name: /(?:Delete queued message|대기 메시지 삭제)/,
    }),
  ).toBeTruthy();
});
