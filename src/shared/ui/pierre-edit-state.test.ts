import type { File } from "@pierre/diffs";
import { Editor, EditStateManager, TextDocument } from "@pierre/diffs/edit";
import { expect, it } from "vitest";

// No rendering is needed: exercise the real retained session at attachment.
function surface(name: string, lang: "typescript" | "markdown") {
  return {
    type: "file",
    getLatestFile: () => ({ name, lang, contents: "disk" }),
    applyDocumentChange() {},
    applySuspendedDocumentChange() {},
    __attachEditor: () => () => undefined,
    __completeEditSession() {},
    getCodeScrollLeft: () => 0,
  } as unknown as File;
}

it("retains undo/redo while updating a renamed draft's URI, language and file name", () => {
  const key = crypto.randomUUID();
  const document = new TextDocument<"file", undefined>(
    "original.ts",
    "original\r\n",
    "typescript",
  );
  document.applyEdits([
    {
      range: {
        start: { line: 0, character: 8 },
        end: { line: 0, character: 8 },
      },
      newText: " edited",
    },
  ]);
  const first = new Editor(
    "file",
    {
      initialState: {
        type: "file",
        document,
        fileInfo: { name: "original.ts", lang: "typescript" },
      },
    },
    key,
  );
  first.edit(surface("original.ts", "typescript"));
  first.cleanUp("discard");
  const renamed = new Editor("file", {}, key);
  try {
    renamed.edit(surface("renamed.md", "markdown"));
    expect(renamed.getFile()).toMatchObject({
      name: "renamed.md",
      lang: "markdown",
      contents: "original edited\r\n",
    });
    const restored = renamed.getEditState()?.document;
    expect(restored?.uri).toBe("file:///renamed.md");
    expect(restored?.languageId).toBe("markdown");
    expect(restored?.eol).toBe("\r\n");
    expect(restored?.version).toBe(document.version);
    restored?.undo();
    expect(restored?.getText()).toBe("original\r\n");
    restored?.redo();
    expect(restored?.getText()).toBe("original edited\r\n");
  } finally {
    renamed.cleanUp("discard");
    EditStateManager.clear("file", key);
  }
});
