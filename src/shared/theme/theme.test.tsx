import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  initializeTheme,
  type ThemePreference,
  ThemeProvider,
  useTheme,
} from "./theme";

const setNativeTheme = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme: setNativeTheme }),
}));

let systemDark = false;
let mediaListeners: Set<(event: MediaQueryListEvent) => void>;
let media: MediaQueryList;

beforeEach(() => {
  localStorage.clear();
  setNativeTheme.mockClear();
  systemDark = false;
  mediaListeners = new Set();
  media = {
    get matches() {
      return systemDark;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn((_type, listener) =>
      mediaListeners.add(listener as (event: MediaQueryListEvent) => void),
    ),
    removeEventListener: vi.fn((_type, listener) =>
      mediaListeners.delete(listener as (event: MediaQueryListEvent) => void),
    ),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("color-scheme");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("follows system appearance until an explicit theme is selected", async () => {
  systemDark = true;
  render(() => (
    <ThemeProvider>
      <ThemeProbe />
    </ThemeProvider>
  ));

  expect(screen.getByTestId("preference").textContent).toBe("system");
  expect(screen.getByTestId("resolved").textContent).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  await waitFor(() => expect(setNativeTheme).toHaveBeenCalledWith(null));

  changeSystemTheme(false);
  expect(screen.getByTestId("resolved").textContent).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");

  fireEvent.click(screen.getByRole("button", { name: "dark" }));
  expect(localStorage.getItem("atte.theme")).toBe("dark");
  expect(screen.getByTestId("resolved").textContent).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  await waitFor(() => expect(setNativeTheme).toHaveBeenCalledWith("dark"));

  changeSystemTheme(false);
  expect(screen.getByTestId("resolved").textContent).toBe("dark");
});

test("normalizes an invalid saved preference and removes its system listener", () => {
  localStorage.setItem("atte.theme", "sepia");
  systemDark = true;
  initializeTheme();

  expect(localStorage.getItem("atte.theme")).toBe("system");
  expect(document.documentElement.dataset.theme).toBe("dark");

  const result = render(() => (
    <ThemeProvider>
      <ThemeProbe />
    </ThemeProvider>
  ));
  expect(media.addEventListener).toHaveBeenCalledWith(
    "change",
    expect.any(Function),
  );

  result.unmount();
  expect(media.removeEventListener).toHaveBeenCalledWith(
    "change",
    expect.any(Function),
  );
});

function changeSystemTheme(dark: boolean) {
  systemDark = dark;
  const event = { matches: dark } as MediaQueryListEvent;
  for (const listener of mediaListeners) listener(event);
}

function ThemeProbe() {
  const { preference, resolvedTheme, setPreference } = useTheme();
  const options: ThemePreference[] = ["system", "light", "dark"];
  return (
    <>
      <span data-testid="preference">{preference()}</span>
      <span data-testid="resolved">{resolvedTheme()}</span>
      {options.map((option) => (
        <button type="button" onClick={() => setPreference(option)}>
          {option}
        </button>
      ))}
    </>
  );
}
