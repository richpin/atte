import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { I18nProvider } from "shared/i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Turn } from "../model/types";
import { Transcript } from "./Transcript";

let resize!: () => void;

beforeEach(() => {
  localStorage.setItem("atte.locale", "en");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function turn(message: string): Turn {
  return {
    id: "turn-1",
    message,
    response: "",
    stopReason: null,
  };
}

function renderTranscript(message: string) {
  render(() => (
    <I18nProvider>
      <Transcript turns={[turn(message)]} />
    </I18nProvider>
  ));
}

function setMessageHeight(message: string, height: number) {
  const content = screen.getByText(message);
  content.style.lineHeight = "20px";
  Object.defineProperty(content, "scrollHeight", {
    configurable: true,
    value: height,
  });
  resize();
  return content;
}

it("does not offer expansion when the user message fits within 20 lines", () => {
  renderTranscript("Short prompt");
  setMessageHeight("Short prompt", 400);

  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

it("expands and collapses a user message taller than 20 lines", () => {
  renderTranscript("Long prompt");
  const content = setMessageHeight("Long prompt", 401);
  const clipping = content.parentElement;

  const showMore = screen.getByRole("button", { name: "Show more" });
  expect(showMore.getAttribute("aria-expanded")).toBe("false");
  expect(showMore.querySelector("svg")?.classList.contains("rotate-180")).toBe(
    false,
  );
  expect(clipping?.classList.contains("max-h-[25rem]")).toBe(true);
  expect(clipping?.classList.contains("overflow-hidden")).toBe(true);

  fireEvent.click(showMore);
  const showLess = screen.getByRole("button", { name: "Show less" });
  expect(showLess.getAttribute("aria-expanded")).toBe("true");
  expect(showLess.querySelector("svg")?.classList.contains("rotate-180")).toBe(
    true,
  );
  expect(clipping?.classList.contains("max-h-[25rem]")).toBe(false);
  expect(clipping?.classList.contains("overflow-hidden")).toBe(false);

  fireEvent.click(showLess);
  expect(
    screen
      .getByRole("button", { name: "Show more" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(clipping?.classList.contains("max-h-[25rem]")).toBe(true);
  expect(clipping?.classList.contains("overflow-hidden")).toBe(true);
});

it("updates folding when wrapping changes the rendered line count", () => {
  renderTranscript("Responsive prompt");
  const content = setMessageHeight("Responsive prompt", 401);
  expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();

  Object.defineProperty(content, "scrollHeight", {
    configurable: true,
    value: 400,
  });
  resize();
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});
