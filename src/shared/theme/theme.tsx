import { makePersisted } from "@solid-primitives/storage";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  createContext,
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  type Signal,
  useContext,
} from "solid-js";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

const storageKey = "atte.theme";
const darkModeQuery = "(prefers-color-scheme: dark)";

export function isThemePreference(value: string): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function readPreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === null || isThemePreference(stored)) return stored ?? "system";
    localStorage.setItem(storageKey, "system");
  } catch {
    return "system";
  }
  return "system";
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

export function initializeTheme() {
  applyDocumentTheme(resolveTheme(readPreference()));
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
  const [system, setSystem] = createSignal(systemTheme());
  const [preference, setPreference] = makePersisted<
    ThemePreference,
    Signal<ThemePreference>
  >(createSignal<ThemePreference>(readPreference()), {
    name: storageKey,
    serialize: (value) => value,
    deserialize: (value) => (isThemePreference(value) ? value : "system"),
  });
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

  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    const media = window.matchMedia(darkModeQuery);
    const updateSystemTheme = (event: MediaQueryListEvent) =>
      setSystem(event.matches ? "dark" : "light");
    media.addEventListener("change", updateSystemTheme);
    onCleanup(() => media.removeEventListener("change", updateSystemTheme));
  }

  return (
    <ThemeContext.Provider
      value={{
        preference,
        resolvedTheme,
        setPreference: (value) => setPreference(value),
      }}
    >
      {props.children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
