import type { Attachment, FileMention } from "./types";

export function mentionFileName(path: string) {
  return path.split("/").at(-1) ?? path;
}

export function mentionQuery(
  value: string,
  start: number,
  end: number,
  mentions: readonly FileMention[] = [],
) {
  if (start !== end || mentions.some((m) => start > m.start && start <= m.end))
    return undefined;
  const before = value.slice(0, start);
  const match = /@([^\n@]*)$/.exec(before);
  if (!match) return undefined;
  const from = start - match[1].length - 1;
  if (mentions.some((m) => m.start >= from && m.start < start))
    return undefined;
  return { query: match[1], start: from, end: start };
}

export function matchingFiles(paths: readonly string[], query: string) {
  const needle = query.toLowerCase();
  const rank = (path: string) => {
    const name = path.split("/").at(-1)?.toLowerCase() ?? "";
    return name === needle
      ? 0
      : name.startsWith(needle)
        ? 1
        : name.includes(needle)
          ? 2
          : 3;
  };
  return paths
    .filter((p) => p.toLowerCase().includes(needle))
    .toSorted((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function attachmentMentions(attachments: readonly Attachment[]) {
  return attachments
    .flatMap((a) => a.resource?.mentions ?? [])
    .toSorted((a, b) => a.start - b.start);
}
