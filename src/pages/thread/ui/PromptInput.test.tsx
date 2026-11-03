import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { CommandToken } from "../model/prompt-document";
import type { PromptEditorHandle } from "./PromptEditor";
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
  let editor!: PromptEditorHandle;
  render(() => (
    <PromptInput
      inputRef={(handle) => {
        editor = handle;
      }}
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

  editor.replaceText(0, editor.value.length, "six wrapped lines");
  expect(input.style.height).toBe("120px");
  expect(input.classList).toContain("overflow-y-auto");

  contentHeight = 240;
  editor.replaceText(0, editor.value.length, "twelve wrapped lines");
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
  let editor!: PromptEditorHandle;
  render(() => (
    <PromptInput
      inputRef={(handle) => {
        editor = handle;
      }}
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

  editor.replaceText(0, editor.value.length, "twelve visual lines");

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

  expect(accepted).toBe(false);
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

const commands = [
  {
    name: "review",
    description: "Review changes",
    inputHint: "Files to review",
  },
  { name: "compact", description: "Compact context", inputHint: null },
];

function autocomplete(initial = "") {
  const [value, setValue] = createSignal(initial);
  const [available, setAvailable] = createSignal(commands);
  const [tokens, setTokens] = createSignal<CommandToken[]>([]);
  const [selectedCommand, setSelectedCommand] = createSignal<string>();
  const [scope, setScope] = createSignal("first");
  const onSubmit = vi.fn();
  let editor!: PromptEditorHandle;
  render(() => (
    <>
      <PromptInput
        inputRef={(handle) => {
          editor = handle;
        }}
        value={value()}
        commands={available()}
        selectedCommand={selectedCommand()}
        commandTokens={tokens()}
        focusScope={scope()}
        disabled={false}
        onInput={(text, command, _mentions, commands) => {
          setTokens(commands ?? []);
          setValue(text);
          setSelectedCommand(command);
        }}
        onSubmit={onSubmit}
      />
      <button type="button" onClick={onSubmit}>
        Send directly
      </button>
    </>
  ));
  const input = screen.getByRole("combobox") as HTMLElement;
  input.focus();
  const edit = (text: string, cursor = text.length) => {
    editor.replaceText(0, editor.value.length, text, cursor);
  };
  return { input, editor, edit, value, setAvailable, setScope, onSubmit };
}

it("opens all commands and completes with Enter before a separate submission", () => {
  const { input, edit, value, onSubmit } = autocomplete();
  edit("/");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(screen.getByText("Review changes")).toBeTruthy();
  expect(screen.queryByText("Files to review")).toBeNull();
  expect(input.getAttribute("aria-activedescendant")).toBe(
    screen.getAllByRole("option")[0].id,
  );
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(value()).toBe("/review ");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.queryByText("Files to review")).toBeNull();
  expect(input.dataset.placeholder).toBe("Files to review");
  expect(input.hasAttribute("aria-describedby")).toBe(false);
  expect(screen.queryByRole("button", { name: "review 명령 제거" })).toBeNull();
  expect(document.activeElement).toBe(input);
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSubmit).toHaveBeenCalledOnce();
});

it("uses Tab and candidate clicks to replace only the name", () => {
  const { input, edit, value } = autocomplete();
  edit("/rev  first\nsecond", 4);
  fireEvent.keyDown(input, { key: "Tab" });
  expect(value()).toBe("/review  first\nsecond");
  fireEvent.click(screen.getByRole("button", { name: "review 명령 편집" }));
  edit("/comp  first\nsecond", 5);
  fireEvent.click(screen.getByRole("option"));
  expect(value()).toBe("/compact  first\nsecond");
});

it("dismisses until the name is edited and keeps ordinary cursor movements closed", () => {
  const { input, editor, edit } = autocomplete();
  edit("/");
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.click(input);
  expect(screen.queryByRole("listbox")).toBeNull();
  edit("/r");
  expect(screen.getByRole("option").textContent).toContain("/review");
  editor.setSelectionRange(0, 0);
  fireEvent.select(input);
  expect(screen.queryByRole("listbox")).toBeNull();
  editor.setSelectionRange(2, 2);
  fireEvent.select(input);
  expect(screen.queryByRole("listbox")).toBeNull();
  edit("/re");
  expect(screen.getByRole("listbox")).toBeTruthy();
});

it("allows Enter submission and native Tab when no candidate matches", () => {
  const { input, edit, onSubmit, setAvailable } = autocomplete();
  edit("/unknown");
  expect(screen.getByRole("status").textContent).toBe(
    "일치하는 명령이 없습니다",
  );
  expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSubmit).toHaveBeenCalledOnce();
  setAvailable([]);
  expect(screen.getByRole("status").textContent).toBe(
    "사용 가능한 명령이 없습니다",
  );
});

it("preserves the highlighted command on updates and resets when it disappears", () => {
  const { input, edit, setAvailable, value } = autocomplete();
  edit("/");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  setAvailable([
    ...commands,
    { name: "another", description: "New", inputHint: null },
  ]);
  expect(screen.getByRole("option", { selected: true }).textContent).toContain(
    "/review",
  );
  setAvailable([commands[1]]);
  expect(value()).toBe("/");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(value()).toBe("/compact ");
});

it("suppresses selection and submission during IME composition and preserves Shift+Enter", async () => {
  const { input, edit, value, onSubmit } = autocomplete();
  edit("/r");
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(value()).toBe("/r");
  fireEvent.compositionEnd(input);
  await Promise.resolve();
  expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
  expect(onSubmit).not.toHaveBeenCalled();
});

it("completes at any slash while preserving surrounding text and the caret", () => {
  const { input, editor, edit, value } = autocomplete();
  for (const prefix of [
    "text ",
    " ",
    "text\n",
    "https://host/",
    "src/",
    "word",
  ]) {
    const text = `${prefix}/r tail\nlast`;
    edit(text, prefix.length + 2);
    expect(screen.getByRole("option").textContent).toContain("/review");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(value()).toBe(`${prefix}/review tail\nlast`);
    expect(editor.value).toBe(value());
    expect(editor.selectionStart).toBe(prefix.length + 7);
    const chip = input.querySelector("[data-command]");
    expect(chip?.textContent).toBe("review");
    expect(chip?.classList).toContain("text-command");
  }
});

it("completes the slash at the caret rather than another slash", () => {
  const { editor, edit, value } = autocomplete();
  edit("/compact\n/rev/path", 13);
  fireEvent.click(screen.getByRole("option", { name: /review/ }));
  expect(value()).toBe("/compact\n/review/path");
  expect(editor.selectionStart).toBe(16);
});

it("completes inside the body while preserving an existing command token", async () => {
  const { input, editor, value } = autocomplete();
  await userEvent.type(input, "/comp{Tab}first");
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}/rev");
  expect(screen.getByRole("option", { name: /review/ })).toBeTruthy();
  await userEvent.keyboard("{Enter}");
  expect(value()).toBe("/compact first\n/review ");
  expect(editor.value).toBe("first\n/review ");
  expect(editor.selectionStart).toBe(editor.value.length);
  expect(
    screen.getByRole("button", { name: "compact 명령 편집" }),
  ).toBeTruthy();
  editor.setSelectionRange(0, editor.value.length);
  await userEvent.keyboard("/rev{Tab}");
  expect(value()).toBe("/compact /review ");
  expect(editor.value).toBe("/review ");
});

it("does not open after whitespace outside the command name", () => {
  const { edit } = autocomplete();
  for (const text of ["text /r ", "text\n/r\n", "/review argument"]) {
    edit(text);
    expect(screen.queryByRole("listbox")).toBeNull();
  }
});

it("closes on thread switches and directly submits without applying the candidate", () => {
  const { edit, value, setScope, onSubmit } = autocomplete();
  edit("/r");
  fireEvent.click(screen.getByRole("button", { name: "Send directly" }));
  expect(value()).toBe("/r");
  expect(onSubmit).toHaveBeenCalledOnce();
  setScope("second");
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("supports native typing, repeated selection keys and returning from arguments", async () => {
  const { input, editor, value, onSubmit } = autocomplete();
  await userEvent.type(input, "/rev");
  expect(screen.getByRole("option").textContent).toContain("/review");
  await userEvent.keyboard("{Tab}");
  expect(value()).toBe("/review ");
  fireEvent.keyDown(input, { key: "Enter", repeat: true });
  expect(onSubmit).not.toHaveBeenCalled();
  await userEvent.type(input, "src/file.ts");
  expect(screen.getByRole("status").textContent).toBe(
    "일치하는 명령이 없습니다",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "review 명령 편집" }),
  );
  editor.setSelectionRange(4, 4);
  fireEvent.select(input);
  await userEvent.keyboard("{Backspace}");
  expect(value()).toBe("/reiew src/file.ts");
  expect(editor.selectionStart).toBe(3);
  expect(screen.getByRole("listbox")).toBeTruthy();
});

it("dismisses on an outside pointer interaction and keeps focus during candidate clicks", async () => {
  const { input, editor, value } = autocomplete();
  await userEvent.type(input, "/");
  await userEvent.click(screen.getByRole("option", { name: /review/ }));
  expect(value()).toBe("/review ");
  expect(document.activeElement).toBe(input);
  editor.setSelectionRange(0, 0);
  fireEvent.keyDown(input, { key: "Backspace" });
  await userEvent.type(input, "/");
  await userEvent.click(screen.getByRole("button", { name: "Send directly" }));
  expect(screen.queryByRole("listbox")).toBeNull();
  await userEvent.click(input);
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("shows an autocomplete selection as a blue token without a slash and edits its arguments", async () => {
  const { input, editor, value } = autocomplete();
  await userEvent.type(input, "/rev{Tab}src");
  const token = screen.getByRole("button", { name: "review 명령 편집" });
  expect(token.textContent).toBe("review");
  expect(token.parentElement?.classList).toContain("text-command");
  expect(editor.value).toBe("src");
  expect(value()).toBe("/review src");
  await userEvent.type(input, " extra");
  expect(editor.value).toBe("src extra");
  expect(value()).toBe("/review src extra");
  editor.setSelectionRange(0, 0);
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(editor.value).toBe("src extra");
  expect(value()).toBe("src extra");
  expect(document.activeElement).toBe(input);
});

it("removes the token with Backspace at the start and keeps the rest of the message", async () => {
  const { input, editor, value } = autocomplete();
  await userEvent.type(input, "/rev{Enter}files");
  editor.setSelectionRange(0, 0);
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(value()).toBe("files");
  expect(editor.selectionStart).toBe(0);
  expect(screen.queryByRole("button", { name: "review 명령 편집" })).toBeNull();
});

it("keeps manually typed commands as plain text and preserves Codex skill prefixes in tokens", async () => {
  const { input, editor, value, setAvailable } = autocomplete();
  setAvailable([{ name: "$review", description: "Review", inputHint: null }]);
  await userEvent.type(input, "/$review ");
  expect(
    screen.queryByRole("button", { name: "$review 명령 편집" }),
  ).toBeNull();
  expect(editor.value).toBe("/$review ");
  await userEvent.clear(input);
  await userEvent.type(input, "/$rev{Tab}");
  expect(
    screen.getByRole("button", { name: "$review 명령 편집" }).textContent,
  ).toBe("$review");
  expect(value()).toBe("/$review ");
  expect(editor.value).toBe("");
});

it("keeps multiple inline command chips through edits, deletion and undo", () => {
  const { input, editor, edit, value } = autocomplete();
  edit("text /rev");
  fireEvent.keyDown(input, { key: "Tab" });
  editor.replaceText(editor.value.length, editor.value.length, "/comp");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(value()).toBe("text /review /compact ");
  expect(input.querySelectorAll("[data-command]")).toHaveLength(2);
  editor.replaceText(0, 0, "prefix ");
  expect(input.querySelectorAll("[data-command]")).toHaveLength(2);
  editor.setSelectionRange(19, 19);
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(value()).toBe("prefix text  /compact ");
  expect(input.querySelectorAll("[data-command]")).toHaveLength(1);
  fireEvent.keyDown(input, { key: "z", ctrlKey: true });
  expect(value()).toBe("prefix text /review /compact ");
  expect(input.querySelectorAll("[data-command]")).toHaveLength(2);
});

it("edits an inline chip on click and can complete it again", () => {
  const { input, editor, edit, value } = autocomplete();
  edit("text /rev tail", 9);
  fireEvent.keyDown(input, { key: "Tab" });
  const chip = input.querySelector("[data-command]");
  expect(chip).toBeTruthy();
  fireEvent.click(chip as Element);
  expect(input.querySelector("[data-command]")).toBeNull();
  expect(editor.selectionStart).toBe(12);
  expect(screen.getByRole("option", { name: /review/ })).toBeTruthy();
  fireEvent.keyDown(input, { key: "Tab" });
  expect(value()).toBe("text /review tail");
  expect(input.querySelector("[data-command]")?.textContent).toBe("review");
});

it("copies inline command text with slashes and retains chips when pasted internally", () => {
  const { input, editor, edit, value } = autocomplete();
  edit("text /rev");
  fireEvent.keyDown(input, { key: "Tab" });
  editor.setSelectionRange(0, editor.value.length);
  const formats = new Map<string, string>();
  const clipboardData = {
    files: [],
    getData: (type: string) => formats.get(type) ?? "",
    setData: (type: string, data: string) => formats.set(type, data),
  };
  fireEvent.copy(input, { clipboardData });
  expect(formats.get("text/plain")).toBe("text /review ");
  editor.setSelectionRange(editor.value.length, editor.value.length);
  fireEvent.paste(input, { clipboardData });
  expect(value()).toBe("text /review text /review ");
  expect(input.querySelectorAll("[data-command]")).toHaveLength(2);
});
