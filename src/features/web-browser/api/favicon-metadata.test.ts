import { afterEach, expect, it, vi } from "vitest";
import script from "../../../../src-tauri/src/browser/favicon.ts?raw";

const metadata = () =>
  new Function(
    "document",
    "window",
    "URL",
    `return (
${script}
)`,
  )(document, window, URL);

afterEach(() => {
  document.head.innerHTML = "";
  vi.unstubAllGlobals();
});

it("uses the origin favicon when no icon is declared", () => {
  expect(metadata()).toEqual({
    url: window.location.href,
    icon: new URL("/favicon.ico", window.location.href).href,
  });
});

it("reads relative icons and updates when page metadata changes", () => {
  document.head.innerHTML =
    '<base href="https://example.com/assets/"><link rel="shortcut icon" href="one.ico">';
  expect(metadata()?.icon).toBe("https://example.com/assets/one.ico");
  document.querySelector("link")?.setAttribute("href", "two.ico");
  expect(metadata()?.icon).toBe("https://example.com/assets/two.ico");
});

it("prefers a matching scalable icon and leaves the page unchanged", () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: media !== "dark",
  }));
  document.head.innerHTML =
    '<link rel="icon" sizes="any" href="https://example.com/vector.svg"><link rel="icon" href="https://example.com/small.png"><link rel="icon" sizes="any" media="dark" href="https://example.com/dark.svg">';
  const before = document.head.innerHTML;
  expect(metadata()?.icon).toBe("https://example.com/vector.svg");
  expect(document.head.innerHTML).toBe(before);
});
