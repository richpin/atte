import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "shared/i18n";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Thought } from "./Thought";

beforeEach(() => localStorage.setItem("atte.locale", "en"));
afterEach(cleanup);

it("renders Markdown only when expanded and keeps the user's choice through updates and completion", async () => {
  const [text, setText] = createSignal(
    "**Inspect**\n\n```ts\nconst n = 1;\n```\n<script>unsafe</script>",
  );
  const [active, setActive] = createSignal(true);
  const { container } = render(() => (
    <I18nProvider>
      <Thought
        part={{ kind: "thought", id: "one", text: text() }}
        active={active()}
      />
    </I18nProvider>
  ));
  const trigger = screen.getByRole("button", { name: "Thinking" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("[data-markdown-body]")).toBeNull();
  fireEvent.click(trigger);
  await waitFor(() =>
    expect(container.querySelector("strong")?.textContent).toBe("Inspect"),
  );
  expect(container.querySelector("pre code")?.textContent).toContain(
    "const n = 1;",
  );
  expect(container.querySelector("script")).toBeNull();
  setText("**Inspect** more");
  setActive(false);
  await waitFor(() =>
    expect(
      container.querySelector("[data-markdown-body]")?.textContent,
    ).toContain("Inspect more"),
  );
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Thinking" })).toBe(trigger);
  expect(container.querySelector(".animate-spin")).toBeNull();
  fireEvent.click(trigger);
  setText("Final reasoning");
  expect(container.querySelector("[data-markdown-body]")).toBeNull();
  fireEvent.click(trigger);
  expect(screen.getByText("Final reasoning")).toBeTruthy();
});

it("supports keyboard toggling and Korean labels without translating the body", async () => {
  localStorage.setItem("atte.locale", "ko");
  const user = userEvent.setup();
  render(() => (
    <I18nProvider>
      <Thought
        part={{ kind: "thought", id: "one", text: "English source" }}
        active={false}
      />
    </I18nProvider>
  ));
  await user.tab();
  const trigger = screen.getByRole("button", { name: "생각 중" });
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("English source")).toBeTruthy();
  await user.keyboard(" ");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
