import { describe, expect, it } from "vitest";
import type { GitCommit } from "../api/git-history";
import { createGraphLayout } from "./git-graph";

const commit = (oid: string, ...parents: string[]): GitCommit => ({
  oid,
  parents,
  author: "test",
  timestamp: 0,
  subject: oid,
});

describe("Git graph frontier", () => {
  it("keeps straight history in one lane and stops at the root", () => {
    const rows = createGraphLayout().append([
      commit("c", "b"),
      commit("b", "a"),
      commit("a"),
    ]);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows[0].edges).toHaveLength(1);
    expect(rows[2].edges.every((edge) => edge.segment === "incoming")).toBe(
      true,
    );
  });
  it("joins a shared ancestor without duplicate parent lanes", () => {
    const rows = createGraphLayout().append([
      commit("merge", "main", "feature"),
      commit("feature", "root"),
      commit("main", "root"),
      commit("root"),
    ]);
    expect(
      rows[0].edges.filter((edge) => edge.segment === "outgoing"),
    ).toHaveLength(2);
    expect(rows[2].edges.find((edge) => edge.segment === "outgoing")?.to).toBe(
      rows[3].lane,
    );
    expect(rows[3].edges).toHaveLength(1);
  });
  it("produces identical row geometry when split across pages", () => {
    const commits = [
      commit("m", "a", "b", "c"),
      commit("a", "r"),
      commit("b", "r"),
      commit("c", "r"),
      commit("r"),
      commit("other-root"),
    ];
    const expected = createGraphLayout().append(commits);
    const paged = createGraphLayout();
    const first = paged.append(commits.slice(0, 2));
    const original = structuredClone(first);
    const rest = paged.append(commits.slice(2));
    expect([...first, ...rest]).toEqual(expected);
    expect(first).toEqual(original);
    expect(
      expected[0].edges.filter((edge) => edge.segment === "outgoing"),
    ).toHaveLength(3);
  });
  it("keeps unrelated tracks connected through interleaved commits", () => {
    const rows = createGraphLayout().append([
      commit("a", "x"),
      commit("b", "y"),
      commit("x"),
      commit("y"),
    ]);
    expect(rows[1].edges).toContainEqual({
      from: 0,
      to: 0,
      color: rows[0].color,
      segment: "through",
    });
    expect(rows[2].edges.some((edge) => edge.segment === "through")).toBe(true);
    expect(rows[3].lane).toBe(rows[1].lane);
  });
});
