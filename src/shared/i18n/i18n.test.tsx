import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, test } from "vitest";
import { I18nProvider, resolveLocale, useI18n } from "./i18n";

afterEach(() => {
  cleanup();
  localStorage.clear();
  setLanguages("ko-KR", "ko", "en-US");
});

test("selects the first supported system language and falls back to English", () => {
  expect(resolveLocale(["ja-JP", "ko-KR", "en-US"])).toBe("ko");
  expect(resolveLocale(["fr-FR", "en-GB"])).toBe("en");
  expect(resolveLocale(["ja-JP"])).toBe("en");
});

test("renders English and reacts when the system language changes", async () => {
  setLanguages("en-US");
  render(() => (
    <I18nProvider>
      <Probe />
    </I18nProvider>
  ));

  expect(screen.getByText("Where do you want to work?")).toBeTruthy();
  expect(screen.getByText("New Thread")).toBeTruthy();
  expect(
    screen.getByText(
      "The working folder could not be found. Choose the folder again.",
    ),
  ).toBeTruthy();
  expect(document.documentElement.lang).toBe("en");

  setLanguages("ko-KR");
  window.dispatchEvent(new Event("languagechange"));

  expect(await screen.findByText("어디에서 작업할까요?")).toBeTruthy();
  expect(document.documentElement.lang).toBe("ko");
});

function Probe() {
  const { t, content } = useI18n();
  return (
    <>
      <p>{t("thread.empty.title")}</p>
      <p>{content("새 스레드")}</p>
      <p>
        {content("작업 폴더를 찾을 수 없습니다. 폴더를 다시 선택해주세요.")}
      </p>
    </>
  );
}

function setLanguages(...languages: string[]) {
  Object.defineProperties(navigator, {
    language: { configurable: true, value: languages[0] },
    languages: { configurable: true, value: languages },
  });
}
