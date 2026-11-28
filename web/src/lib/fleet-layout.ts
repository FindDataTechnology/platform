// Fleet canvas layout seeds (agent-fleet-cockpit v2, extracted from the v1
// FleetGraph so the pure longest-path layering stays single-sourced and
// unit-testable). The React Flow canvas feeds these coordinates in as node
// positions; it re-runs ONLY when the member/edge signature changes — live
// turn events flip node/edge data, never positions.

export interface GraphMember {
  id: string;
  title: string;
  targetKind: string;
}

export interface GraphEdge {
  kind: string;
  from?: string; // undefined for trigger edges (external cron source)
  to?: string;
  targets?: string[];
  aggregate?: { kind: string; judge?: string };
  cron?: string;
  implicit?: boolean;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: string; // persona | cluster | a2a | tool | cron | event
  x: number;
  y: number;
}

export interface GraphLink {
  from: string;
  to: string;
  kind: string;
  label?: string;
}

const NODE_W = 220;
const NODE_H = 96;
const LAYER_X = 300;
const ROW_Y = 132;
const PAD = 24;

export const CANVAS_NODE_SIZE = { width: NODE_W, height: NODE_H };

// Expand declared edges into (nodes, links). Virtual source nodes: cron:<expr>
// for trigger edges, the event source name for event edges. Fanout expands to
// one link per target (judge rides the label, not a fake link). Implicit
// supervisor dispatch grants are filtered by the caller before this runs.
export function expand(members: GraphMember[], edges: GraphEdge[]) {
  const nodes = new Map<string, GraphNode>();
  for (const m of members) nodes.set(m.id, { id: m.id, label: m.title, kind: m.targetKind, x: 0, y: 0 });
  const links: GraphLink[] = [];
  for (const e of edges) {
    if (e.kind === "trigger" && e.to) {
      const srcId = `cron:${e.cron ?? "定时"}`;
      if (!nodes.has(srcId)) nodes.set(srcId, { id: srcId, label: e.cron ?? "定时", kind: "cron", x: 0, y: 0 });
      links.push({ from: srcId, to: e.to, kind: "trigger" });
    } else if (e.kind === "event" && e.to) {
      const srcId = e.from ?? "event:?";
      if (!nodes.has(srcId)) nodes.set(srcId, { id: srcId, label: e.from ?? "事件源", kind: "event", x: 0, y: 0 });
      links.push({ from: srcId, to: e.to, kind: "event" });
    } else if (e.kind === "fanout" && e.from) {
      for (const t of e.targets ?? []) {
        links.push({ from: e.from, to: t, kind: "fanout" });
      }
    } else if (e.from && e.to) {
      links.push({ from: e.from, to: e.to, kind: e.kind });
    }
  }
  return { nodes, links };
}

// Longest-path layering over the DAG of links; links into an already-layered
// ancestor (declared cycles) are back-edges — they draw, but never re-layer.
function layer(nodes: Map<string, GraphNode>, links: GraphLink[]) {
  const incoming = new Map<string, string[]>();
  for (const l of links) {
    if (!incoming.has(l.to)) incoming.set(l.to, []);
    incoming.get(l.to)!.push(l.from);
  }
  const memo = new Map<string, number>();
  const back = new Set<string>();
  const depthOf = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) {
      back.add(id);
      return -1;
    }
    seen.add(id);
    let d = 0;
    for (const p of incoming.get(id) ?? []) {
      const pd = depthOf(p, seen);
      if (pd >= 0 && !back.has(p + "→" + id) && !(back.has(p) && pd === -1)) d = Math.max(d, pd + 1);
    }
    seen.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const id of nodes.keys()) depthOf(id, new Set<string>());
  const depth = new Map<string, number>();
  for (const [id, d] of memo) depth.set(id, d);
  return { depth, back };
}

export function computeGraph(members: GraphMember[], edges: GraphEdge[]) {
  const { nodes, links } = expand(members, edges);
  const { depth } = layer(nodes, links);
  const byLayer = new Map<number, string[]>();
  for (const id of nodes.keys()) {
    const d = depth.get(id) ?? 0;
    if (!byLayer.has(d)) byLayer.set(d, []);
    byLayer.get(d)!.push(id);
  }
  for (const [d, ids] of byLayer) {
    ids.sort((a, b) => (nodes.get(a)!.label.localeCompare(nodes.get(b)!.label)));
    ids.forEach((id, i) => {
      const n = nodes.get(id)!;
      n.x = PAD + d * LAYER_X;
      n.y = PAD + i * ROW_Y;
    });
  }
  const maxLayer = Math.max(0, ...byLayer.keys());
  const maxRows = Math.max(1, ...[...byLayer.values()].map((v) => v.length));
  const size = {
    width: PAD * 2 + maxLayer * LAYER_X + NODE_W,
    height: PAD * 2 + (maxRows - 1) * ROW_Y + NODE_H,
  };
  return { nodes: [...nodes.values()], links, size };
}

// Kind colors — single palette for SVG fills (canvas), mirrored by the badge
// tailwind classes in FleetsPage. trigger=gray, report=green, dispatch=blue,
// handoff=amber, fanout=purple, event=cyan.
export const KIND_COLORS: Record<string, string> = {
  trigger: "#6b7280",
  report: "#22c55e",
  dispatch: "#3b82f6",
  handoff: "#f59e0b",
  fanout: "#a855f7",
  event: "#06b6d4",
};

export const NODE_COLORS: Record<string, string> = {
  persona: "#334155",
  cluster: "#0ea5e9",
  a2a: "#8b5cf6",
  tool: "#64748b",
  cron: "#6b7280",
  event: "#06b6d4",
};
