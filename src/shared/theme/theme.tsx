import { createPrefersDark } from "@solid-primitives/media";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createContext, createEffect, type JSX, useContext } from "solid-js";
import { useSettings } from "../settings";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

const darkModeQuery = "(prefers-color-scheme: dark)";

export function isThemePreference(value: string): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function systemTheme(): ResolvedTheme {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(darkModeQuery).matches
    ? "dark"
    : "light";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

function applyDocumentTheme(theme: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function initializeTheme(preference: ThemePreference = "system") {
  applyDocumentTheme(resolveTheme(preference));
}

interface ThemeContextValue {
  preference: () => ThemePreference;
  resolvedTheme: () => ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: (): ThemePreference => "system",
  resolvedTheme: systemTheme,
  setPreference: () => undefined,
});

export function ThemeProvider(props: { children: JSX.Element }) {
  const prefersDark =
    typeof window.matchMedia === "function" ? createPrefersDark() : () => false;
  const system = (): ResolvedTheme => (prefersDark() ? "dark" : "light");
  const settings = useSettings();
  const preference = () => settings.values().theme;
  const resolvedTheme = (): ResolvedTheme =>
    preference() === "system" ? system() : (preference() as ResolvedTheme);

  createEffect(() => {
    const selected = preference();
    applyDocumentTheme(resolvedTheme());
    try {
      void getCurrentWindow()
        .setTheme(selected === "system" ? null : selected)
        .catch(() => undefined);
    } catch {
      // The web-only development and test environments have no native window.
    }
  });

  return (
    <ThemeContext.Provider
      value={{
        preference,
        resolvedTheme,
        setPreference: (theme) => void settings.update({ theme }),
      }}
    >
      {props.children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
