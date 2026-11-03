import { createFileMentionChip } from "./file-mention-chip";

export interface InlineChip {
  start: number;
  end: number;
  label: string;
  displayLabel?: string;
  title: string;
}

export function prepareInlineChips(
  source: string,
  chips: readonly InlineChip[],
) {
  const replacements = new Map<string, InlineChip>();
  const prefix = `ATTECHIP${crypto.randomUUID().replaceAll("-", "")}X`;
  let result = "";
  let end = 0;
  for (const chip of chips.toSorted((a, b) => a.start - b.start)) {
    if (
      chip.start < end ||
      chip.end <= chip.start ||
      chip.end > source.length ||
      source.slice(chip.start, chip.end) !== chip.label
    )
      continue;
    const token = `${prefix}${replacements.size}END`;
    replacements.set(token, chip);
    result += source.slice(end, chip.start) + token;
    end = chip.end;
  }
  result += source.slice(end);
  function decorate(root: HTMLElement) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      if (!node.data.includes(prefix)) continue;
      const fragment = document.createDocumentFragment();
      const pattern = new RegExp(`${prefix}[0-9]+END`, "g");
      let last = 0;
      for (const match of node.data.matchAll(pattern)) {
        const chip = replacements.get(match[0]);
        if (!chip) continue;
        fragment.append(node.data.slice(last, match.index));
        const span = createFileMentionChip(
          chip.title,
          chip.displayLabel ?? chip.label,
        );
        fragment.append(span);
        last = match.index + match[0].length;
      }
      fragment.append(node.data.slice(last));
      node.replaceWith(fragment);
    }
  }
  return {
    source: result,
    decorate,
    containsToken: (text: string) => text.includes(prefix),
    plain: (text: string) => {
      let value = text;
      for (const [token, chip] of replacements)
        value = value.replaceAll(token, chip.label);
      return value;
    },
  };
}
