import type { AvailableCommand } from "./types";

export function commandName(value: string): string | undefined {
  return /^\/([^\s]*)/.exec(value)?.[1];
}

interface CommandQuery {
  query: string;
  start: number;
  end: number;
}

export function commandQuery(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): CommandQuery | undefined {
  if (selectionStart < 1) return undefined;
  const start = value.lastIndexOf("/", selectionStart - 1);
  if (start < 0) return undefined;
  const query = /^[^\s/]*/.exec(value.slice(start + 1))?.[0] ?? "";
  const end = start + query.length + 1;
  if (selectionEnd > end) return undefined;
  return { query, start, end };
}

export function matchingCommands(
  commands: readonly AvailableCommand[],
  query: string,
): AvailableCommand[] {
  const needle = query.toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().includes(needle))
    .toSorted(
      (left, right) =>
        Number(right.name.toLowerCase().startsWith(needle)) -
          Number(left.name.toLowerCase().startsWith(needle)) ||
        left.name.localeCompare(right.name),
    );
}

export function completeCommand(
  value: string,
  name: string,
  range: CommandQuery,
) {
  const suffix = value.slice(range.end);
  const replacement = `/${name}${suffix ? "" : " "}`;
  return {
    value: value.slice(0, range.start) + replacement + suffix,
    cursor: range.start + replacement.length,
  };
}
