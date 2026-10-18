import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImagePreview } from "./image-preview";

const createUrl = vi.fn();
const revokeUrl = vi.fn();
beforeEach(() => {
  let next = 0;
  createUrl.mockReset().mockImplementation(() => `blob:image-${++next}`);
  revokeUrl.mockReset();
  vi.stubGlobal("URL", {
    createObjectURL: createUrl,
    revokeObjectURL: revokeUrl,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reports decoding status and revokes replaced and unmounted images", () => {
  const [blob, setBlob] = createSignal(new Blob(["first"]));
  const view = render(() => (
    <ImagePreview
      blob={blob()}
      alt="file.png"
      loadingLabel="Loading"
      errorLabel="Decode failed"
    />
  ));
  expect(screen.getByRole("status").textContent).toBe("Loading");
  const first = screen.getByAltText("file.png");
  fireEvent.load(first);
  expect(screen.queryByRole("status")).toBeNull();
  setBlob(new Blob(["second"]));
  expect(revokeUrl).toHaveBeenCalledWith("blob:image-1");
  fireEvent.error(first);
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.error(screen.getByAltText("file.png"));
  expect(screen.getByRole("alert").textContent).toBe("Decode failed");
  view.unmount();
  expect(revokeUrl).toHaveBeenCalledWith("blob:image-2");
});

it("keeps SVG source in an image Blob without inserting markup into the document", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>window.executed = true</script></svg>';
  const view = render(() => (
    <ImagePreview
      blob={new Blob([svg], { type: "image/svg+xml" })}
      alt="file.svg"
      loadingLabel="Loading"
      errorLabel="Failed"
    />
  ));
  expect(createUrl.mock.calls[0][0].type).toBe("image/svg+xml");
  expect(screen.getByAltText("file.svg").getAttribute("src")).toBe(
    "blob:image-1",
  );
  expect(
    view.container.querySelector("svg, script, iframe, object, embed"),
  ).toBeNull();
});
