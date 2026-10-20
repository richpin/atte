import type { GitCommit } from "../api/git-history";

export const COMMIT_ROW_HEIGHT = 54;
export const LANE_WIDTH = 16;
export const GRAPH_PADDING = 14;
type Lane = { oid: string; color: number };
export type GraphEdge = {
  from: number;
  to: number;
  color: number;
  segment: "incoming" | "outgoing" | "through";
};
export type GraphRow = {
  commit: GitCommit;
  lane: number;
  color: number;
  lanes: number;
  edges: GraphEdge[];
};

/** Row-local swimlanes, as used by VS Code's SCM graph. No whole-DAG layout.
 * Keep the unresolved parent frontier between pages; never move existing rows.
 */
export function createGraphLayout() {
  const lanes: (Lane | undefined)[] = [];
  let nextColor = 0;
  const vacant = () => {
    const index = lanes.findIndex((lane) => !lane);
    return index < 0 ? lanes.length : index;
  };
  return {
    append(commits: GitCommit[]): GraphRow[] {
      return commits.map((commit) => {
        const incoming = lanes.slice();
        const existing = lanes.findIndex((lane) => lane?.oid === commit.oid);
        const lane = existing < 0 ? vacant() : existing;
        const color = lanes[lane]?.color ?? nextColor++ % 5;
        const edges: GraphEdge[] = [];
        for (let index = 0; index < incoming.length; index++) {
          const target = incoming[index];
          if (!target) continue;
          if (target.oid === commit.oid) {
            edges.push({
              from: index,
              to: lane,
              color: target.color,
              segment: "incoming",
            });
            lanes[index] = undefined;
          } else {
            edges.push({
              from: index,
              to: index,
              color: target.color,
              segment: "through",
            });
          }
        }
        for (let index = 0; index < commit.parents.length; index++) {
          const oid = commit.parents[index];
          let target = lanes.findIndex((lane) => lane?.oid === oid);
          if (target < 0) {
            target = index === 0 && !lanes[lane] ? lane : vacant();
            lanes[target] = {
              oid,
              color: index === 0 ? color : nextColor++ % 5,
            };
          }
          edges.push({
            from: lane,
            to: target,
            color: lanes[target]?.color ?? color,
            segment: "outgoing",
          });
        }
        const width = Math.max(lane + 1, incoming.length, lanes.length);
        while (lanes.length && !lanes.at(-1)) lanes.pop();
        return { commit, lane, color, lanes: width, edges };
      });
    },
  };
}

export const laneX = (lane: number) => GRAPH_PADDING + lane * LANE_WIDTH;
export const graphWidth = (lanes: number) =>
  GRAPH_PADDING * 2 + Math.max(0, lanes - 1) * LANE_WIDTH;
export function edgePath(edge: GraphEdge): string {
  const y1 = edge.segment === "outgoing" ? COMMIT_ROW_HEIGHT / 2 : 0;
  const y2 =
    edge.segment === "incoming" ? COMMIT_ROW_HEIGHT / 2 : COMMIT_ROW_HEIGHT;
  const x1 = laneX(edge.from),
    x2 = laneX(edge.to),
    middle = (y1 + y2) / 2;
  return x1 === x2
    ? `M ${x1} ${y1} V ${y2}`
    : `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`;
}
