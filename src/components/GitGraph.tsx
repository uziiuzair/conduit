import { useMemo } from "react";
import { useStore } from "../store";
import { THEMES } from "../themes";

export interface GraphCommit {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  refs: string;
}

const ROW_H = 30;
const LANE_W = 14;
const PAD_X = 9;
const NODE_R = 4;

type Lane = { hash: string; color: number } | null;
type Half = "top" | "bottom" | "full";
interface Seg {
  from: number;
  to: number;
  color: number;
  half: Half;
}
interface Row {
  commit: GraphCommit;
  col: number;
  color: number;
  segs: Seg[];
  isHead: boolean;
}

/**
 * Swimlane layout. Walks commits newest→oldest, keeping a set of open "lanes"
 * (each waiting for its next commit). Each commit lands in the lane(s) expecting
 * it; its first parent continues that lane (and color), extra parents (merges)
 * branch into new/existing lanes. Produces per-row segments to draw.
 */
function buildRows(commits: GraphCommit[]): { rows: Row[]; lanes: number } {
  let lanes: Lane[] = [];
  let nextColor = 0;
  let maxCol = 0;
  const rows: Row[] = [];

  for (const commit of commits) {
    const before = lanes.slice();
    // Dedupe parents (guards against duplicate/octopus parent rendering artifacts).
    const parents = Array.from(new Set(commit.parents));

    const expecting: number[] = [];
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k]?.hash === commit.hash) expecting.push(k);
    }

    let col: number;
    let color: number;
    if (expecting.length > 0) {
      col = expecting[0];
      color = lanes[col]!.color;
    } else {
      col = lanes.indexOf(null);
      if (col === -1) {
        col = lanes.length;
        lanes.push(null);
      }
      color = nextColor++;
    }

    // All lanes expecting this commit converge into `col`; clear them.
    for (const k of expecting) lanes[k] = null;

    const mergeTargets: { pc: number; color: number }[] = [];
    if (parents.length > 0) {
      lanes[col] = { hash: parents[0], color };
      for (let p = 1; p < parents.length; p++) {
        const par = parents[p];
        let pc = lanes.findIndex((l) => l?.hash === par);
        if (pc === -1) {
          pc = lanes.indexOf(null);
          if (pc === -1) {
            pc = lanes.length;
            lanes.push(null);
          }
          lanes[pc] = { hash: par, color: nextColor++ };
        }
        mergeTargets.push({ pc, color: lanes[pc]!.color });
      }
    } else {
      lanes[col] = null; // root commit
    }

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    const segs: Seg[] = [];
    // Passing lanes (unrelated to this commit) run straight through the cell.
    for (let k = 0; k < before.length; k++) {
      const b = before[k];
      if (b && b.hash !== commit.hash) {
        segs.push({ from: k, to: k, color: b.color, half: "full" });
      }
    }
    // Lanes that arrived expecting this commit merge into the node (top half).
    for (const k of expecting) {
      segs.push({ from: k, to: col, color, half: "top" });
    }
    // Node continues to its parents (bottom half).
    if (parents.length > 0) {
      segs.push({ from: col, to: col, color, half: "bottom" });
      for (const m of mergeTargets) {
        segs.push({ from: col, to: m.pc, color: m.color, half: "bottom" });
      }
    }

    let localMax = Math.max(col, lanes.length - 1);
    for (const s of segs) localMax = Math.max(localMax, s.from, s.to);
    maxCol = Math.max(maxCol, localMax);

    rows.push({
      commit,
      col,
      color,
      segs,
      isHead: /(^|[\s,])HEAD\b/.test(commit.refs),
    });
  }

  return { rows, lanes: maxCol + 1 };
}

const cx = (k: number) => PAD_X + k * LANE_W + LANE_W / 2;

function pathFor(seg: Seg, i: number): string {
  const yt = i * ROW_H;
  const yc = i * ROW_H + ROW_H / 2;
  const yb = (i + 1) * ROW_H;
  const x1 = cx(seg.from);
  const x2 = cx(seg.to);
  if (seg.half === "full") return `M ${x1} ${yt} L ${x1} ${yb}`;
  if (seg.half === "top") {
    const m = (yt + yc) / 2;
    return `M ${x1} ${yt} C ${x1} ${m} ${x2} ${m} ${x2} ${yc}`;
  }
  const m = (yc + yb) / 2;
  return `M ${x1} ${yc} C ${x1} ${m} ${x2} ${m} ${x2} ${yb}`;
}

function refBadges(refs: string) {
  if (!refs.trim()) return [];
  return refs.split(",").map((r) => r.trim()).filter(Boolean).map((r) => {
    if (r.startsWith("HEAD -> ")) return { label: r.slice(8), kind: "head" as const };
    if (r === "HEAD") return { label: "HEAD", kind: "head" as const };
    if (r.startsWith("tag: ")) return { label: r.slice(5), kind: "tag" as const };
    return { label: r.replace(/^origin\//, "↑"), kind: "branch" as const };
  });
}

export function GitGraph({ commits }: { commits: GraphCommit[] }) {
  const laneColors = THEMES[useStore((s) => s.activeThemeId)].gitLanes;
  const laneColor = (i: number) =>
    laneColors[((i % laneColors.length) + laneColors.length) % laneColors.length];
  const { rows, lanes } = useMemo(() => buildRows(commits), [commits]);

  if (commits.length === 0) {
    return <p className="placeholder">No commits found.</p>;
  }

  const graphW = PAD_X * 2 + lanes * LANE_W;
  const totalH = rows.length * ROW_H;

  return (
    <div className="git-graph" style={{ height: totalH }}>
      <svg
        className="git-graph-svg"
        width={graphW}
        height={totalH}
        style={{ width: graphW, height: totalH }}
      >
        {rows.flatMap((row, i) =>
          row.segs.map((seg, j) => (
            <path
              key={`${i}-${j}`}
              d={pathFor(seg, i)}
              stroke={laneColor(seg.color)}
              strokeWidth={1.6}
              fill="none"
              strokeLinecap="round"
            />
          )),
        )}
        {rows.map((row, i) => (
          <circle
            key={`n-${i}`}
            cx={cx(row.col)}
            cy={i * ROW_H + ROW_H / 2}
            r={row.isHead ? NODE_R + 1 : NODE_R}
            fill={laneColor(row.color)}
            stroke={row.isHead ? "var(--text-bright)" : "var(--panel-bg)"}
            strokeWidth={row.isHead ? 1.5 : 1}
          />
        ))}
      </svg>

      <div className="git-graph-rows">
        {rows.map((row, i) => (
          <div
            className="git-row"
            key={row.commit.hash + i}
            style={{ height: ROW_H, paddingLeft: graphW + 4 }}
          >
            {refBadges(row.commit.refs).map((b, k) => (
              <span className={`ref-chip ${b.kind}`} key={k}>
                {b.label}
              </span>
            ))}
            <span className="subj">{row.commit.subject}</span>
            <span className="gh">{row.commit.hash}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
