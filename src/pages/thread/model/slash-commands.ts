import type { AvailableCommand } from "./types";

export function commandName(value: string): string | undefined {
  return /^\/([^\s]*)/.exec(value)?.[1];
}

export function commandQuery(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): string | undefined {
  const name = commandName(value);
  if (
    name === undefined ||
    selectionStart < 1 ||
    selectionEnd > name.length + 1
  )
    return undefined;
  return name;
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

export function completeCommand(value: string, name: string) {
  const previous = commandName(value);
  const suffix = previous === undefined ? "" : value.slice(previous.length + 1);
  return {
    value: `/${name}${suffix || " "}`,
    cursor: name.length + 2,
  };
}
