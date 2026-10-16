import {
  type FileDiffMetadata,
  getFiletypeFromFileName,
  getSharedHighlighter,
  VirtualizedFileDiff,
  Virtualizer,
} from "@pierre/diffs";
import type { ResolvedTheme } from "../theme";

export async function createFileDiffRenderer(
  container: HTMLElement,
  scrollRoot: HTMLElement,
  scrollContent: HTMLElement,
  metadata: FileDiffMetadata,
  theme: ResolvedTheme,
) {
  let diff = metadata;
  try {
    await getSharedHighlighter({
      themes: ["github-light", "github-dark"],
      langs: [metadata.lang ?? getFiletypeFromFileName(metadata.name)],
      preferredHighlighter: "shiki-js",
    });
  } catch {
    // A grammar failure must not prevent reviewing the underlying text.
    diff = { ...metadata, lang: "text" };
    await getSharedHighlighter({
      themes: ["github-light", "github-dark"],
      langs: ["text"],
      preferredHighlighter: "shiki-js",
    });
  }
  const virtualizer = new Virtualizer();
  virtualizer.setup(scrollRoot, scrollContent);
  const viewer = new VirtualizedFileDiff(
    {
      theme: { light: "github-light", dark: "github-dark" },
      themeType: theme,
      preferredHighlighter: "shiki-js",
      diffStyle: "unified",
      disableFileHeader: true,
      overflow: "wrap",
      hunkSeparators: "line-info-basic",
      expansionLineCount: 20,
      unsafeCSS: `
        :host { --diffs-font-size: 12px; }
        [data-expand-button][data-expand-all-button] { display: flex; padding-inline: 8px; }
      `,
    },
    virtualizer,
  );
  try {
    viewer.render({ fileDiff: diff, containerWrapper: container });
  } catch (error) {
    viewer.cleanUp();
    virtualizer.cleanUp();
    throw error;
  }
  return {
    setTheme: (value: ResolvedTheme) => viewer.setThemeType(value),
    setExpanded: (expanded: boolean) => {
      viewer.setOptions({ ...viewer.options, expandUnchanged: expanded });
    },
    refresh: () => virtualizer.markDOMDirty(),
    dispose: () => {
      viewer.cleanUp();
      virtualizer.cleanUp();
    },
  };
}
