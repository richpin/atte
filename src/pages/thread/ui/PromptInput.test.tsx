import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { PromptInput } from "./PromptInput";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("grows from two visual lines through ten before scrolling internally", () => {
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    lineHeight: "20px",
    paddingTop: "0px",
    paddingBottom: "0px",
    borderTopWidth: "0px",
    borderBottomWidth: "0px",
  } as CSSStyleDeclaration);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  render(() => (
    <PromptInput
      value=""
      disabled={false}
      onInput={() => {}}
      onSubmit={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  let contentHeight = 120;
  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    get: () => contentHeight,
  });

  fireEvent.input(input, { target: { value: "six wrapped lines" } });
  expect(input.style.height).toBe("120px");
  expect(input.classList).toContain("overflow-y-auto");

  contentHeight = 240;
  fireEvent.input(input, { target: { value: "twelve wrapped lines" } });
  expect(input.style.height).toBe("200px");
});

it("includes textarea padding and borders outside the ten text lines", () => {
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    lineHeight: "20px",
    paddingTop: "4px",
    paddingBottom: "4px",
    borderTopWidth: "1px",
    borderBottomWidth: "1px",
  } as CSSStyleDeclaration);
  render(() => (
    <PromptInput
      value=""
      disabled={false}
      onInput={() => {}}
      onSubmit={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    get: () => 248,
  });

  fireEvent.input(input, { target: { value: "twelve visual lines" } });

  expect(input.style.height).toBe("210px");
});

it("keeps text paste native and ignores an accompanying image", () => {
  const onPasteImage = vi.fn();
  render(() => (
    <PromptInput
      value=""
      disabled={false}
      onInput={() => {}}
      onSubmit={() => {}}
      onPasteImage={onPasteImage}
    />
  ));
  const image = new File(["image"], "clipboard.png", { type: "image/png" });

  const accepted = fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: {
      getData: (type: string) => (type === "text/plain" ? "  text  " : ""),
      files: [image],
    },
  });

  expect(accepted).toBe(true);
  expect(onPasteImage).not.toHaveBeenCalled();
});

it("captures an image-only paste and ignores html", () => {
  const onPasteImage = vi.fn();
  render(() => (
    <PromptInput
      value=""
      disabled={false}
      onInput={() => {}}
      onSubmit={() => {}}
      onPasteImage={onPasteImage}
    />
  ));
  const image = new File(["image"], "clipboard.png", { type: "image/png" });

  const accepted = fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: {
      getData: (type: string) => (type === "text/html" ? "<b>image</b>" : ""),
      files: [image],
    },
  });

  expect(accepted).toBe(false);
  expect(onPasteImage).toHaveBeenCalledWith(image);
});

it("reports image-only paste when image attachments are unavailable", () => {
  const onUnsupportedImagePaste = vi.fn();
  render(() => (
    <PromptInput
      value=""
      disabled={false}
      onInput={() => {}}
      onSubmit={() => {}}
      onUnsupportedImagePaste={onUnsupportedImagePaste}
    />
  ));
  const image = new File(["image"], "clipboard.png", { type: "image/png" });

  fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: { getData: () => "", files: [image] },
  });

  expect(onUnsupportedImagePaste).toHaveBeenCalledOnce();
});
