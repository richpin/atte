import { cleanup, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { I18nProvider, useI18n } from "../i18n";
import { LanguageMenu } from "./language-menu";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

test("changes the app language from the menu", async () => {
  renderApp();

  await userEvent.click(screen.getByRole("button", { name: "언어" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "English" }));

  expect(await screen.findByRole("button", { name: "Language" })).toBeTruthy();
  expect(screen.getByText("What do you want to build?")).toBeTruthy();
  expect(localStorage.getItem("atte.locale")).toBe("en");
});

test("restores a saved language and can return to the system setting", async () => {
  localStorage.setItem("atte.locale", "en");
  renderApp();

  expect(screen.getByText("What do you want to build?")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Language" }));
  await userEvent.click(
    screen.getByRole("menuitemradio", { name: "System settings" }),
  );

  expect(await screen.findByRole("button", { name: "언어" })).toBeTruthy();
  expect(screen.getByText("무엇을 만들고 싶으세요?")).toBeTruthy();
  expect(localStorage.getItem("atte.locale")).toBe("system");
});

function renderApp() {
  render(() => (
    <I18nProvider>
      <LanguageMenu />
      <Probe />
    </I18nProvider>
  ));
}

function Probe() {
  const { t } = useI18n();
  return <p>{t("thread.empty.title")}</p>;
}
