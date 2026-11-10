import type { ResponsePart } from "./types";

interface ResponseGroup {
  id: string;
  startIndex: number;
  workLog: boolean;
  parts: ResponsePart[];
}

export function groupResponseParts(parts: ResponsePart[]): ResponseGroup[] {
  const groups: ResponseGroup[] = [];
  parts.forEach((part, startIndex) => {
    const workLog = part.kind === "thought" || part.kind === "tool";
    const previous = groups.at(-1);
    if (workLog && previous?.workLog) previous.parts.push(part);
    else groups.push({ id: part.id, startIndex, workLog, parts: [part] });
  });
  return groups;
}
