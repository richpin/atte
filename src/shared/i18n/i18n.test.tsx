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

  expect(screen.getByText("What do you want to build?")).toBeTruthy();
  expect(screen.getByText("New Thread")).toBeTruthy();
  expect(
    screen.getByText(
      "The working folder could not be found. Choose the folder again.",
    ),
  ).toBeTruthy();
  expect(document.documentElement.lang).toBe("en");

  setLanguages("ko-KR");
  window.dispatchEvent(new Event("languagechange"));

  expect(await screen.findByText("무엇을 만들고 싶으세요?")).toBeTruthy();
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

test("translates worktree errors while preserving paths and Git diagnostics", () => {
  setLanguages("en-US");
  function WorktreeErrorProbe() {
    const { message } = useI18n();
    return (
      <p data-testid="worktree-error">
        {message(
          "선택한 하위 폴더가 HEAD 커밋에 없습니다.\nWorktree 정리에 실패했습니다. 보존된 경로: /work/한글 repo\nfatal: contains modified files",
          "thread.error.create",
        )}
      </p>
    );
  }
  render(() => (
    <I18nProvider>
      <WorktreeErrorProbe />
    </I18nProvider>
  ));
  expect(screen.getByTestId("worktree-error").textContent).toBe(
    "The selected subfolder does not exist in the HEAD commit.\nWorktree cleanup failed. Preserved path: /work/한글 repo\nfatal: contains modified files",
  );
});
