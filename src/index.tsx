/* @refresh reload */
import { render } from "solid-js/web";
import App from "./app/App";
import { resolveLocale } from "./shared/i18n";
import { initializeSettings } from "./shared/settings";
import { initializeTheme } from "./shared/theme";

void initializeSettings().then((settings) => {
  initializeTheme(settings.values().theme);
  const locale = settings.values().locale;
  document.documentElement.lang =
    locale === "system" ? resolveLocale(navigator.languages) : locale;
  render(
    () => <App settings={settings} />,
    document.getElementById("root") as HTMLElement,
  );
});
