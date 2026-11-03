import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { closeMentionSearch, searchMentionFiles } from "../api/threads";
import type { FileMention } from "../model/types";
import type { PromptEditorHandle } from "./PromptEditor";
import { PromptInput } from "./PromptInput";

vi.mock("../api/threads", () => ({
  searchMentionFiles: vi.fn(),
  closeMentionSearch: vi.fn(async () => {}),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function composer() {
  const [value, setValue] = createSignal("");
  const [mentions, setMentions] = createSignal<FileMention[]>([]);
  const [thread, setThread] = createSignal("first");
  let editor!: PromptEditorHandle;
  const onSubmit = vi.fn();
  render(() => (
    <PromptInput
      value={value()}
      mentions={mentions()}
      threadId={thread()}
      focusScope={thread()}
      commands={[]}
      disabled={false}
      inputRef={(handle) => {
        editor = handle;
      }}
      onInput={(text, _command, next) => {
        setValue(text);
        setMentions(next ?? []);
      }}
      onSubmit={onSubmit}
    />
  ));
  editor.focus();
  return { editor, value, mentions, setThread, onSubmit };
}

it("renders horizontal Pierre icons, completes at the caret and deletes/undoes a chip atomically", async () => {
  vi.mocked(searchMentionFiles).mockResolvedValue([
    { path: "src/index.ts", directory: false, symlink: false },
    { path: "index.ts", directory: false, symlink: false },
    { path: "folder", directory: true, symlink: false },
  ]);
  const { editor, value, mentions, onSubmit } = composer();
  editor.replaceText(0, 0, "review @ind");
  const items = await screen.findAllByRole("option");
  expect(items).toHaveLength(2);
  expect(items[0].classList.contains("flex-row")).toBe(true);
  expect(items[0].classList.contains("flex-col")).toBe(false);
  await waitFor(() =>
    expect(items[0].querySelector("svg use")?.getAttribute("href")).toContain(
      "file-tree-builtin-typescript",
    ),
  );
  expect(items[0].textContent).toContain("./");
  fireEvent.keyDown(editor.dom, { key: "ArrowDown" });
  fireEvent.keyDown(editor.dom, { key: "Enter" });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(value()).toBe("review @src/index.ts ");
  expect(mentions()).toHaveLength(1);
  expect(
    editor.dom
      .querySelector("[data-file-mention]")
      ?.classList.contains("text-command"),
  ).toBe(true);
  const chip = editor.dom.querySelector<HTMLElement>("[data-file-mention]");
  expect(chip?.textContent).toBe("index.ts");
  expect(chip?.title).toBe("src/index.ts");
  await waitFor(() =>
    expect(chip?.querySelector("svg use")?.getAttribute("href")).toContain(
      "file-tree-builtin-typescript",
    ),
  );
  editor.setSelectionRange(20, 20);
  fireEvent.keyDown(editor.dom, { key: "Backspace" });
  expect(mentions()).toHaveLength(0);
  fireEvent.keyDown(editor.dom, { key: "z", ctrlKey: true });
  expect(mentions()).toHaveLength(1);
  expect(closeMentionSearch).toHaveBeenCalled();
});

it("opens file completion when @ follows ordinary text without a space", async () => {
  vi.mocked(searchMentionFiles).mockResolvedValue([
    { path: "src/index.ts", directory: false, symlink: false },
  ]);
  const { editor, value, mentions } = composer();
  editor.replaceText(0, 0, "prefix@ind");
  await screen.findByRole("option");
  fireEvent.keyDown(editor.dom, { key: "Enter" });
  expect(value()).toBe("prefix@src/index.ts ");
  expect(mentions()).toMatchObject([
    { path: "src/index.ts", start: 6, end: 19 },
  ]);
});

it("ignores a pending search after changing threads and reports search errors", async () => {
  let resolve!: (files: Awaited<ReturnType<typeof searchMentionFiles>>) => void;
  vi.mocked(searchMentionFiles).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { editor, setThread } = composer();
  editor.replaceText(0, 0, "@");
  expect(screen.getByRole("status").textContent).toContain("검색하는 중");
  setThread("second");
  resolve([{ path: "stale.txt", directory: false, symlink: false }]);
  await Promise.resolve();
  expect(screen.queryByRole("option")).toBeNull();
  vi.mocked(searchMentionFiles).mockRejectedValue(new Error("unavailable"));
  editor.replaceText(0, editor.value.length, "@again");
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "검색하지 못했습니다",
    ),
  );
});

it("copies chips as plain text plus editor data and preserves chips on internal paste", async () => {
  vi.mocked(searchMentionFiles).mockResolvedValue([
    { path: "src/한글.ts", directory: false, symlink: false },
  ]);
  const { editor, mentions, value } = composer();
  editor.replaceText(0, 0, "@한글");
  await screen.findByRole("option");
  fireEvent.keyDown(editor.dom, { key: "Enter" });
  editor.setSelectionRange(0, editor.value.length);
  const formats = new Map<string, string>();
  const clipboardData = {
    files: [],
    getData: (type: string) => formats.get(type) ?? "",
    setData: (type: string, data: string) => formats.set(type, data),
  };
  fireEvent.copy(editor.dom, { clipboardData });
  expect(formats.get("text/plain")).toBe("@src/한글.ts ");
  expect(
    JSON.parse(formats.get("application/x-atte-prompt") ?? "{}").mentions,
  ).toHaveLength(1);
  editor.setSelectionRange(editor.value.length, editor.value.length);
  fireEvent.paste(editor.dom, { clipboardData });
  expect(value()).toBe("@src/한글.ts @src/한글.ts ");
  expect(mentions()).toHaveLength(2);
  expect(mentions()[0].id).not.toBe(mentions()[1].id);
  expect(mentions()[1].order).toBeGreaterThan(mentions()[0].order);
});
