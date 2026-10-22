import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { showErrorToast, ToastHost } from "./toast";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

function mount(locale: "en" | "ko") {
  localStorage.setItem("atte.locale", locale);
  render(() => (
    <I18nProvider>
      <ToastHost />
    </I18nProvider>
  ));
}

it("announces a notification and provides a localized dismiss control", () => {
  mount("ko");
  showErrorToast("연결 실패");
  expect(screen.getByRole("alert").textContent).toContain("연결 실패");
  fireEvent.click(screen.getByRole("button", { name: "알림 닫기" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("renders ACP detail literally and omits empty descriptions", () => {
  mount("ko");
  const raw = "first line\n<img src=x onerror=alert(1)>";
  showErrorToast("메시지 오류", raw);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain(raw);
  expect(alert.querySelector("img")).toBeNull();
  expect(alert.querySelector("[class*='whitespace-pre-wrap']")).toBeTruthy();
  showErrorToast("설정 오류", "  ");
  expect(screen.getAllByRole("alert")[1].textContent).toBe("설정 오류");
});

it("automatically closes after five seconds and pauses while interacting", async () => {
  vi.useFakeTimers();
  mount("en");
  showErrorToast("Connection failed");
  await vi.advanceTimersByTimeAsync(2_000);
  const close = screen.getByRole("button", { name: "Dismiss notification" });
  fireEvent.focusIn(close);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.focusOut(close);
  await vi.advanceTimersByTimeAsync(3_001);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("limits visible notifications to three and clears them on teardown", () => {
  mount("en");
  for (let index = 0; index < 4; index++) showErrorToast(`Error ${index}`);
  expect(screen.getAllByRole("alert")).toHaveLength(3);
  cleanup();
  mount("en");
  expect(screen.queryByRole("alert")).toBeNull();
});
