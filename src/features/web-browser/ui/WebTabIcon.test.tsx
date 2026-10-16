import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { WebTabIcon } from "./WebTabIcon";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("falls back to globe and recovers when a new site icon loads", async () => {
  const requests: { onload: () => void; onerror: () => void }[] = [];
  vi.stubGlobal(
    "Image",
    class {
      onload = () => {};
      onerror = () => {};
      constructor() {
        requests.push(this);
      }
    },
  );
  const [src, setSrc] = createSignal<string | null>(null);
  const { container } = render(() => (
    <WebTabIcon src={src()} class="size-3.5" />
  ));
  expect(container.querySelector("svg")).not.toBeNull();
  setSrc("https://example.com/broken.ico");
  await waitFor(() => expect(requests).toHaveLength(1));
  requests[0].onerror();
  expect(container.querySelector("svg")).not.toBeNull();
  setSrc("https://example.org/icon.svg");
  await waitFor(() => expect(requests).toHaveLength(2));
  requests[1].onload();
  await waitFor(() =>
    expect(container.querySelector("img")?.src).toBe(
      "https://example.org/icon.svg",
    ),
  );
  expect(container.querySelector("svg")).toBeNull();
});
