import { type Node as ProseNode, Schema } from "prosemirror-model";
import { mentionFileName } from "./file-mentions";
import type { FileMention } from "./types";

export interface CommandToken {
  name: string;
  start: number;
  end: number;
}

export const promptSchema = new Schema({
  nodes: {
    doc: { content: "inline*" },
    text: { group: "inline" },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      toDOM: () => ["br"],
      parseDOM: [{ tag: "br" }],
    },
    command: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { name: {} },
      toDOM: (node) => [
        "span",
        {
          "data-command": node.attrs.name,
          class: "inline rounded-md bg-command/10 px-1.5 py-0.5 text-command",
          contenteditable: "false",
        },
        node.attrs.name,
      ],
      parseDOM: [
        {
          tag: "span[data-command]",
          getAttrs: (dom) => ({ name: dom.getAttribute("data-command") }),
        },
      ],
    },
    mention: {
      inline: true,
      group: "inline",
      atom: true,
      selectable: true,
      attrs: { id: {}, path: {}, order: {} },
      toDOM: (node) => [
        "span",
        {
          "data-file-mention": node.attrs.path,
          "data-mention-id": node.attrs.id,
          "data-mention-order": node.attrs.order,
          class: "inline rounded-md bg-command/10 px-1.5 py-0.5 text-command",
          title: node.attrs.path,
          contenteditable: "false",
        },
        mentionFileName(node.attrs.path),
      ],
      parseDOM: [
        {
          tag: "span[data-file-mention]",
          getAttrs: (dom) => ({
            id: dom.getAttribute("data-mention-id") ?? crypto.randomUUID(),
            path: dom.getAttribute("data-file-mention"),
            order: Number(dom.getAttribute("data-mention-order") ?? 0),
          }),
        },
      ],
    },
  },
});

function textNodes(text: string): ProseNode[] {
  return text
    .split("\n")
    .flatMap((line, index) => [
      ...(index ? [promptSchema.nodes.hard_break.create()] : []),
      ...(line ? [promptSchema.text(line)] : []),
    ]);
}

export function promptDocument(
  value: string,
  mentions: readonly FileMention[],
  commands: readonly CommandToken[] = [],
) {
  const nodes: ProseNode[] = [];
  let end = 0;
  const chips = [
    ...mentions.map((mention) => ({
      ...mention,
      label: `@${mention.path}`,
      node: promptSchema.nodes.mention.create(mention),
    })),
    ...commands.map((command) => ({
      ...command,
      label: `/${command.name}`,
      node: promptSchema.nodes.command.create({ name: command.name }),
    })),
  ].toSorted((a, b) => a.start - b.start);
  for (const chip of chips) {
    if (chip.start < end || value.slice(chip.start, chip.end) !== chip.label)
      continue;
    nodes.push(...textNodes(value.slice(end, chip.start)), chip.node);
    end = chip.end;
  }
  nodes.push(...textNodes(value.slice(end)));
  return promptSchema.nodes.doc.create(null, nodes);
}

export function promptValue(doc: ProseNode) {
  let value = "";
  const mentions: FileMention[] = [];
  const commands: CommandToken[] = [];
  doc.forEach((node) => {
    if (node.type.name === "mention") {
      const start = value.length;
      value += `@${node.attrs.path}`;
      mentions.push({
        id: node.attrs.id,
        path: node.attrs.path,
        order: node.attrs.order,
        start,
        end: value.length,
      });
    } else if (node.type.name === "command") {
      const start = value.length;
      value += `/${node.attrs.name}`;
      commands.push({ name: node.attrs.name, start, end: value.length });
    } else value += node.isText ? node.text : "\n";
  });
  return { value, mentions, commands };
}

export function textOffset(doc: ProseNode, position: number) {
  let offset = 0;
  doc.forEach((node, pos) => {
    if (pos >= position) return;
    offset +=
      node.type.name === "mention"
        ? `@${node.attrs.path}`.length
        : node.type.name === "command"
          ? `/${node.attrs.name}`.length
          : Math.min(node.nodeSize, position - pos);
  });
  return offset;
}
export function documentPosition(doc: ProseNode, offset: number) {
  let position = 0;
  let used = 0;
  doc.forEach((node) => {
    if (used >= offset) return;
    const length =
      node.type.name === "mention"
        ? `@${node.attrs.path}`.length
        : node.type.name === "command"
          ? `/${node.attrs.name}`.length
          : node.nodeSize;
    position +=
      offset - used >= length
        ? node.nodeSize
        : node.isText
          ? offset - used
          : node.nodeSize;
    used += length;
  });
  return position;
}
