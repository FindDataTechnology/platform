// Fleet canvas (agent-fleet-cockpit v2 face 1) — the cockpit's primary view.
//
// Posts as cards, declared orchestration edges as kind-colored curves, cron
// and external signal sources as virtual nodes; zoom/pan/minimap; in-flight
// turns (the live store) pulse their node and animate the edge that ignited
// them; edge weight rides the cockpit's 24h edgeTraffic. Design mode (face 4)
// reuses this canvas with an edit layer on top.
//
// Nodes are draggable (add-fleet-canvas-drag): dragging rearranges THIS
// browser's view only — positions persist per fleet in localStorage and never
// touch fleet declaration data. Layout seeds come from the pure fleet-layout
// layerer; stored overrides win per node, and a node without an override (new
// post, cleared storage, unparseable archive) falls back to its seed.
//
// Route-level lazy chunk: @xyflow/react rides this file's import graph only.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MiniSpan } from "@/components/fleet/MiniSpan";
import { BotPlatformIcon } from "@/components/bots/BotPlatformIcons";
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  KIND_COLORS,
  NODE_COLORS,
  computeGraph,
  type GraphEdge,
  type GraphMember,
} from "@/lib/fleet-layout";
import type { LiveTurn, TurnResultEntry } from "@/store/fleet-store";

// ── input shapes (MemberView projections; kept local so the page owns less) ──

export interface CanvasSlot {
  key: string;
  label: string;
  value: string | number;
  unit: string | null;
  trend: { direction: "up" | "down" | "flat" | "changed"; deltaValue: number | null } | null;
}

export interface CanvasPost {
  id: string;
  title: string;
  kind: string;
  status: string; // presence state: on_duty | paused | missing | vacant | passive
  statusReason: string;
  slots: CanvasSlot[];
  lastRunAt: string | null;
  nextRunAt: string | null;
  cadenceEnabled: boolean;
  effectiveModel: string | null;
  modelNotice: string | null;
  lastTurnFailed: boolean;
  consecutiveFailures: number;
  // Skipped rounds (fix-fleet-turn-veracity): the newest turn was a skip and
  // how many sit inside the tolerance window — a muted chip, never the
  // destructive failure tone.
  lastTurnSkipped: boolean;
  skippedRounds: number;
  /** Bot platform for bot-kind posts (fleet-ops-canvas native icon). */
  botType?: string | null;
}

export interface CanvasTraffic {
  from: string;
  to: string;
  kind: string;
  turns: number;
  ok?: number;
  failed?: number;
}

type PostData = {
  post: CanvasPost;
  live: boolean;
  connectable: boolean;
  /** Fleet id for the mini span's turn lookup (fleet-ops-canvas). */
  fleetId: string;
  /** Ledger/trace turn id of the in-flight turn on this post, if any. */
  liveTraceTurnId: string | null;
} & Record<string, unknown>;

type SourceData = {
  label: string;
  kind: string;
  live: boolean;
  connectable: boolean;
} & Record<string, unknown>;

const STATUS_RING: Record<string, string> = {
  on_duty: "#22c55e",
  paused: "#94a3b8",
  missing: "#f59e0b",
  vacant: "#ef4444",
  passive: "#94a3b8",
  // fix-fleet-failure-visibility: a post whose rounds keep failing produces
  // NOTHING while its trigger keeps firing — louder than `missing` (which at
  // least means "no signal"), distinct from the vacancy red.
  failing: "#dc2626",
};

function trendGlyph(t: CanvasSlot["trend"]): string {
  if (!t) return "";
  return t.direction === "up" ? "↑" : t.direction === "down" ? "↓" : t.direction === "changed" ? "±" : "→";
}

// Same verdict as the tree card's slot chip: up reads success, down reads
// destructive, everything else stays muted (the card's exact coloring — no
// new on-target semantics invented on the canvas).
function trendClass(t: CanvasSlot["trend"]): string {
  return t?.direction === "up" ? "text-success" : t?.direction === "down" ? "text-destructive" : "text-muted-foreground";
}

function fmtClock(v: string | null, locale: string): string {
  if (!v) return "—";
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Edges anchor on these. They stay invisible but INTERACTIVE: design mode's
// drag-connect starts on the source handle (pointerEvents must not be none —
// read mode blocks connections via nodesConnectable instead).
const HIDDEN_HANDLE = { style: { opacity: 0, width: 8, height: 8 } } as const;

// ── Runtime particle overlay (fleet-ops-canvas) ──────────────────────────────
//
// A custom edge wrapper: the edge itself keeps its existing look/flow dashes
// (React Flow `animated`), while a `<g>` of tiny circles animates along the
// SAME bezier path via CSS offset-path — live turns ride it now, just-ended
// turns fade out within a short decay window (failed → red). The overlay is a
// sibling layer: if offset-path is unsupported (older Safari) or the kill
// switch is on, the group renders nothing and the base edge is unaffected.

const FAIL_RED = "#ef4444";
const DECAY_WINDOW_MS = 2_500;
const MAX_PARTICLES_PER_EDGE = 6;

const offsetPathSupported =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("offset-path", "path('M0,0 h1')");
const overlayEnabled = import.meta.env.VITE_FLEET_OPS_OVERLAY !== "off" && offsetPathSupported;

type ParticleData = {
  activeCount: number;
  /** Just-ended outcomes inside the decay window (failed first). */
  fading: { status: string; endedAt: number }[];
  color: string;
};

function ParticleEdge(props: EdgeProps) {
  const [path] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  const data = (props.data ?? {}) as ParticleData;
  const live = Math.min(MAX_PARTICLES_PER_EDGE, data.activeCount ?? 0);
  const fading = (data.fading ?? []).slice(0, MAX_PARTICLES_PER_EDGE - live);
  const offsetStyle = { offsetPath: `path("${path}")` } as React.CSSProperties;
  const edgeKey = String(props.data?.edgeKey ?? props.id);
  return (
    <>
      <BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd} />
      {overlayEnabled && (live > 0 || fading.length > 0) ? (
        <g data-testid={`edge-particles-${edgeKey}`} className={fading.some((f) => f.status !== "ok") ? "failing" : undefined}>
          {["p0", "p1", "p2", "p3", "p4", "p5"].slice(0, live).map((pid, i) => (
            <circle
              key={`${edgeKey}-${pid}`}
              r={2.5}
              fill={data.color}
              className="fleet-particle-live"
              style={{ ...offsetStyle, animationDelay: `${(i * 1.8) / live}s` }}
            />
          ))}
          {fading.map((f, i) => (
            <circle
              key={`${edgeKey}-f${f.endedAt}-${f.status}`}
              r={2.5}
              fill={f.status === "ok" ? data.color : FAIL_RED}
              className="fleet-particle-fade"
              style={{ ...offsetStyle, animationDelay: `${Math.min(1.2, i * 0.35)}s` }}
            />
          ))}
        </g>
      ) : null}
    </>
  );
}

// Shared keyframes — inline styles carry the per-edge path and the per-particle
// delay, so a single document-level style block serves every edge.
const PARTICLE_CSS = `
.fleet-particle-live, .fleet-particle-fade { pointer-events: none; }
.fleet-particle-live { animation: fleet-particle-run 1.8s linear infinite; }
.fleet-particle-fade { animation: fleet-particle-fadeout 2.5s ease-out forwards; }
@keyframes fleet-particle-run {
  0% { offset-distance: 0%; opacity: 0.9; }
  90% { opacity: 0.9; }
  100% { offset-distance: 100%; opacity: 0; }
}
@keyframes fleet-particle-fadeout {
  0% { offset-distance: 0%; opacity: 0.95; }
  55% { offset-distance: 55%; opacity: 0.8; }
  100% { offset-distance: 75%; opacity: 0; }
}
`;

const edgeTypes = { particle: ParticleEdge };

function PostNodeView({ data, id, selected }: NodeProps<Node<PostData>>) {
  const { t, i18n } = useTranslation();
  const post = data.post;
  const ring = STATUS_RING[post.status] ?? "#94a3b8";
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid={`canvas-node-${id}`}
      className={`w-[220px] rounded-lg border bg-card p-2 text-left shadow-sm transition-shadow ${
        data.live ? "border-blue-500/60 shadow-[0_0_0_3px_rgba(59,130,246,0.25)]" : "border-border"
      }`}
    >
      <div className="flex items-center gap-1.5">
        {post.kind === "bot" ? (
          <span className="shrink-0" data-testid={`canvas-bot-icon-${id}`}>
            <BotPlatformIcon type={post.botType ?? ""} className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <span className="relative flex h-2.5 w-2.5 shrink-0" title={post.statusReason}>
          {data.live ? (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: "#3b82f6" }} />
          ) : null}
          <span
            className="relative inline-flex h-2.5 w-2.5 rounded-full"
            style={{ background: ring }}
            data-testid={`canvas-status-${id}`}
          />
        </span>
        <span className="truncate text-xs font-medium" title={post.title}>
          {post.title}
        </span>
        <span className="ml-auto rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">{t(`fleets.kind.${post.kind}`)}</span>
      </div>
      {post.slots.length > 0 ? (
        <div className="mt-1 flex min-w-0 flex-wrap gap-1 overflow-hidden">
          {post.slots.slice(0, 4).map((s) => {
            // Slot values are free-form: an agent may report a prose summary
            // into a slot, which would blow the card wide open. Chips stay
            // one line — the full text rides the hover title.
            const full = `${s.label}: ${s.value}${s.unit ?? ""}`;
            const raw = String(s.value);
            const short = raw.length > 16 ? `${raw.slice(0, 15)}…` : raw;
            return (
              <span
                key={s.key}
                className="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-full bg-muted px-1.5 py-px text-[10px]"
                title={full}
              >
                <span className="shrink-0 text-muted-foreground">{s.label}</span>
                <span className="min-w-0 truncate font-medium">{short}</span>
                {s.trend ? (
                  <span className={`shrink-0 ${trendClass(s.trend)}`}>
                    {trendGlyph(s.trend)}
                    {s.trend.deltaValue != null && s.trend.direction !== "flat" ? `${s.trend.deltaValue > 0 ? "+" : ""}${s.trend.deltaValue}` : ""}
                  </span>
                ) : null}
              </span>
            );
          })}
          {post.slots.length > 4 ? <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">+{post.slots.length - 4}</span> : null}
        </div>
      ) : null}
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        {post.lastTurnSkipped ? (
          <span className="rounded-full bg-muted px-1.5 py-px text-muted-foreground" data-testid={`canvas-turn-skipped-${post.id}`}>
            {t("fleets.turn.skipped")}
            {post.skippedRounds > 0 ? ` ×${post.skippedRounds}` : ""}
          </span>
        ) : null}
        {post.lastTurnFailed && !post.lastTurnSkipped ? (
          <span className="rounded-full bg-destructive/15 px-1.5 py-px text-destructive">
            {t("fleets.turn.failed")}
            {post.consecutiveFailures >= 3 ? ` ×${post.consecutiveFailures}` : ""}
          </span>
        ) : null}
        {post.effectiveModel ? (
          <span
            className={`truncate rounded-full px-1.5 py-px ${post.modelNotice ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-muted"}`}
            title={post.modelNotice ?? undefined}
          >
            {post.effectiveModel}
          </span>
        ) : null}
        <span className="ml-auto whitespace-nowrap" title={`${t("fleets.evidence.lastRun")} / ${t("fleets.evidence.nextRun")}`}>
          {fmtClock(post.lastRunAt, i18n.language)} · {fmtClock(post.nextRunAt, i18n.language)}
        </span>
      </div>
      {(hovered || selected) ? (
        <MiniSpan
          fleetId={data.fleetId}
          memberId={post.id}
          liveTraceTurnId={data.liveTraceTurnId}
          lastTurnFailed={post.lastTurnFailed}
          lastTurnSkipped={post.lastTurnSkipped}
        />
      ) : null}
      <Handle type="target" position={Position.Left} isConnectable={data.connectable} {...HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={data.connectable} {...HIDDEN_HANDLE} />
    </div>
  );
}

function SourceNodeView({ data, id }: NodeProps<Node<SourceData>>) {
  return (
    <div
      data-testid={`canvas-node-${id}`}
      className="flex w-[150px] items-center gap-1.5 rounded-lg border border-dashed border-border bg-muted/40 px-2 py-1.5"
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: NODE_COLORS[data.kind] ?? "#64748b" }} />
      <span className="truncate text-[11px] text-muted-foreground" title={data.label}>
        {data.label}
      </span>
      {data.live ? <span className="ml-auto h-1.5 w-1.5 animate-ping rounded-full bg-blue-500" /> : null}
      <Handle type="target" position={Position.Left} isConnectable={data.connectable} {...HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={data.connectable} {...HIDDEN_HANDLE} />
    </div>
  );
}

const nodeTypes = { post: PostNodeView, source: SourceNodeView };

function trafficKeyOf(t: CanvasTraffic): string {
  return `${t.from}→${t.to}:${t.kind}`;
}

export function FleetCanvas({
  members,
  edges,
  traffic,
  liveTurns,
  recentResults = [],
  fleetId,
  designMode = false,
  draftEdges = [],
  removedEdgeKeys = [],
  onConnectEdge,
  onEdgeSelect,
  onNodeSelect,
  onDraftEdgeRemove,
}: {
  members: CanvasPost[];
  edges: GraphEdge[];
  traffic: CanvasTraffic[];
  liveTurns: LiveTurn[];
  /** Recent turn outcomes for the decay lane of the particle overlay. */
  recentResults?: TurnResultEntry[];
  /** Owner fleet — keys the local position archive (add-fleet-canvas-drag). */
  fleetId: string;
  /** Design mode (face 4): enable connect handles + draft visuals. */
  designMode?: boolean;
  /** Draft (not-yet-applied) edges, drawn dashed. */
  draftEdges?: GraphEdge[];
  /** Keys of declared edges the draft removes (hidden while designing). */
  removedEdgeKeys?: string[];
  onConnectEdge?: (from: string, to: string) => void;
  /** Read mode: an edge was clicked — open the edge inspector. */
  onEdgeSelect?: (edge: GraphEdge) => void;
  /** A post node was clicked — open the member inspector. */
  onNodeSelect?: (memberId: string) => void;
  /** Design mode: a DRAFT edge was clicked — drop it from the draft. */
  onDraftEdgeRemove?: (from: string, to: string, kind: string) => void;
}) {
  const { t } = useTranslation();

  // Layout signature: only a member/edge change re-lays-out the board (spec:
  // 实时更新不重排). Live turns and traffic flip data in place below.
  // The edge universe the canvas draws: declared edges (minus the draft's
  // removals, while designing) plus the draft's additions (dashed).
  const effectiveEdges = useMemo(() => {
    if (!designMode || removedEdgeKeys.length === 0) return edges;
    const drop = (e: GraphEdge) => {
      if (e.kind === "fanout") return (e.targets ?? []).every((t) => removedEdgeKeys.includes(`${e.from}→${t}:fanout`));
      return removedEdgeKeys.includes(`${e.from ?? ""}→${e.to ?? ""}:${e.kind}`);
    };
    return edges.filter((e) => !drop(e));
  }, [edges, designMode, removedEdgeKeys]);

  const allEdges = useMemo(() => [...effectiveEdges, ...draftEdges], [effectiveEdges, draftEdges]);
  const draftKeySet = useMemo(() => {
    const set = new Set<string>();
    for (const e of draftEdges) {
      if (e.kind === "fanout") for (const t of e.targets ?? []) set.add(`${e.from}→${t}:fanout`);
      else set.add(`${e.from ?? ""}→${e.to ?? ""}:${e.kind}`);
    }
    return set;
  }, [draftEdges]);

  const signature = useMemo(
    () => `${members.map((m) => `${m.id}:${m.title}:${m.kind}`).join("|")}#${allEdges.map((e) => `${e.kind}:${e.from ?? "*"}:${e.to ?? ""}:${(e.targets ?? []).join(",")}`).join("|")}`,
    [members, allEdges],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature IS the memo key by design — live turns and traffic flip data in place, a member/edge change (and only that) re-lays-out the board (spec: 实时更新不重排)
  const laid = useMemo(() => {
    const graphMembers: GraphMember[] = members.map((m) => ({ id: m.id, title: m.title, targetKind: m.kind }));
    return computeGraph(graphMembers, allEdges);
  }, [signature]);

  // ── local position archive (add-fleet-canvas-drag) ─────────────────────────
  // Dragging rearranges THIS browser's view: overrides win per node over the
  // layout seed and persist per fleet in localStorage. Declaration data is
  // never touched; a corrupt/absent archive silently falls back to the seed.

  const storageKey = `platform.fleetCanvas.${fleetId}`;

  const loadOverrides = useCallback((): Record<string, { x: number; y: number }> => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as { v?: number; p?: Record<string, { x: number; y: number }> };
      if (parsed?.v !== 1 || !parsed.p || typeof parsed.p !== "object") return {};
      const out: Record<string, { x: number; y: number }> = {};
      for (const [id, pos] of Object.entries(parsed.p)) {
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) out[id] = { x: pos.x, y: pos.y };
      }
      return out;
    } catch {
      return {};
    }
  }, [storageKey]);

  const [overrides, setOverrides] = useState<Record<string, { x: number; y: number }>>(loadOverrides);
  useEffect(() => {
    setOverrides(loadOverrides());
  }, [loadOverrides]);

  const persistNodePosition = useCallback(
    (id: string, pos: { x: number; y: number }) => {
      setOverrides((prev) => {
        const next = { ...prev, [id]: pos };
        try {
          localStorage.setItem(storageKey, JSON.stringify({ v: 1, p: next }));
        } catch { /* quota/private mode: the drag still applies for this visit */ }
        return next;
      });
    },
    [storageKey],
  );

  const resetLayout = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
    } catch { /* nothing to clean up */ }
    setOverrides({});
  }, [storageKey]);

  const liveByMember = useMemo(() => {
    const map = new Map<string, LiveTurn>();
    for (const lt of liveTurns) map.set(lt.memberId, lt);
    return map;
  }, [liveTurns]);

  // An edge is in flight when a live turn was ignited along it (parent post →
  // post, by kind). Count per edge — the particle density is proportional to
  // concurrent turn instances on the same edge (fleet-ops-canvas).
  const liveEdgeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const lt of liveTurns) {
      if (lt.parentMemberId && lt.edgeKind) {
        const k = `${lt.parentMemberId}→${lt.memberId}:${lt.edgeKind}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return counts;
  }, [liveTurns]);

  // Decay lane: outcomes whose endedAt sits inside the fade window paint the
  // edge once more (failed red) before it returns to static. The window's
  // expiry needs ONE tick while decays are on screen — nothing else re-renders
  // the layer after the last WS event lands.
  const [decayTick, setDecayTick] = useState(0);
  const decayEdges = useMemo(() => {
    void decayTick; // re-derives as the fade window rolls past each outcome
    const byEdge = new Map<string, { status: string; endedAt: number }[]>();
    const now = Date.now();
    for (const r of recentResults) {
      if (!r.parentMemberId || !r.edgeKind) continue;
      if (now - r.endedAt > DECAY_WINDOW_MS) continue;
      const k = `${r.parentMemberId}→${r.memberId}:${r.edgeKind}`;
      if (!byEdge.has(k)) byEdge.set(k, []);
      byEdge.get(k)!.push({ status: r.status ?? "ok", endedAt: r.endedAt });
    }
    return byEdge;
  }, [recentResults, decayTick]);
  useEffect(() => {
    if (decayEdges.size === 0) return;
    const timer = setInterval(() => setDecayTick((x) => x + 1), 500);
    return () => clearInterval(timer);
  }, [decayEdges.size]);

  const trafficByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const tr of traffic) map.set(trafficKeyOf(tr), tr.turns);
    return map;
  }, [traffic]);

  // Controlled nodes: the layout seed (signature-keyed) plus the drag
  // overrides feed a state that onNodesChange mutates while dragging — a live
  // event still only flips node data, never positions (spec: 实时更新不重排).
  const seededNodes: Node[] = useMemo(
    () =>
      laid.nodes.map((n) => {
        const isPost = members.some((m) => m.id === n.id);
        const liveTurn = liveByMember.get(n.id);
        const live = liveTurn != null;
        const position = overrides[n.id] ?? { x: n.x, y: n.y };
        return {
          id: n.id,
          type: isPost ? "post" : "source",
          position,
          data: isPost
            ? ({
                post: members.find((m) => m.id === n.id)!,
                live,
                connectable: designMode,
                fleetId,
                liveTraceTurnId: liveTurn?.turnId ?? null,
              } satisfies PostData as PostData)
            : ({ label: n.label, kind: n.kind, live, connectable: designMode } satisfies SourceData as SourceData),
        };
      }),
    [laid, members, liveByMember, designMode, overrides, fleetId],
  );

  const [nodes, setNodes] = useState<Node[]>(seededNodes);
  useEffect(() => {
    setNodes(seededNodes);
  }, [seededNodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, []);

  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      persistNodePosition(node.id, node.position);
    },
    [persistNodePosition],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      laid.links.map((l) => {
        const key = `${l.from}→${l.to}:${l.kind}`;
        const color = KIND_COLORS[l.kind] ?? "#94a3b8";
        const turns = trafficByKey.get(key) ?? 0;
        const liveCount = liveEdgeCounts.get(key) ?? 0;
        const fading = decayEdges.get(key) ?? [];
        const draft = draftKeySet.has(key);
        return {
          id: key,
          type: "particle",
          source: l.from,
          target: l.to,
          animated: liveCount > 0,
          data: { activeCount: liveCount, fading, color: draft ? "#3b82f6" : color, edgeKey: key },
          style: {
            stroke: draft ? "#3b82f6" : color,
            strokeWidth: 1.5 + Math.min(2.5, Math.sqrt(turns) * 0.5),
            ...(draft ? { strokeDasharray: "7 4" } : {}),
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: draft ? "#3b82f6" : color, width: 16, height: 16 },
        };
      }),
    [laid, liveEdgeCounts, trafficByKey, draftKeySet, decayEdges],
  );

  const legendKinds = useMemo(() => [...new Set(laid.links.map((l) => l.kind))], [laid]);

  const handleConnect = useCallback(
    (c: { source: string | null; target: string | null }) => {
      if (!designMode || !c.source || !c.target || c.source === c.target) return;
      onConnectEdge?.(c.source, c.target);
    },
    [designMode, onConnectEdge],
  );

  const handleEdgeClick = useCallback(
    (_e: unknown, edge: Edge) => {
      const m = /^(.*)→(.*):(.*)$/.exec(edge.id);
      if (!m) return;
      const from = m[1] ?? "";
      const to = m[2] ?? "";
      const kind = m[3] ?? "";
      if (designMode && draftKeySet.has(edge.id)) {
        onDraftEdgeRemove?.(from, to, kind);
        return;
      }
      if (!designMode) {
        const hit =
          allEdges.find((g) => g.kind === kind && g.from === from && g.to === to) ??
          (kind === "fanout" ? allEdges.find((g) => g.kind === "fanout" && g.from === from) : undefined);
        if (hit) onEdgeSelect?.(hit);
      }
    },
    [designMode, draftKeySet, onDraftEdgeRemove, onEdgeSelect, allEdges],
  );

  const handleNodeClick = useCallback(
    (_e: unknown, node: Node) => {
      if (!designMode && members.some((m) => m.id === node.id)) onNodeSelect?.(node.id);
    },
    [designMode, members, onNodeSelect],
  );

  return (
    <div className="mt-1" data-testid="fleet-canvas">
      <style>{PARTICLE_CSS}</style>
      <div className="mb-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
        {legendKinds.map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLORS[k] ?? "#94a3b8" }} />
            {t(`fleets.orch.edge.${k}`)}
          </span>
        ))}
        {Object.keys(overrides).length > 0 ? (
          <button
            type="button"
            className="ml-auto rounded-md border border-border px-2 py-px hover:bg-muted"
            onClick={resetLayout}
            data-testid="canvas-reset-layout"
          >
            {t("fleets.canvas.reset")}
          </button>
        ) : null}
      </div>
      <div className="h-[380px] overflow-hidden rounded-md border border-border">
        <ReactFlow
          nodes={nodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          fitView
          minZoom={0.2}
          maxZoom={1.75}
          nodesDraggable
          nodesConnectable={designMode}
          elementsSelectable
          onConnect={handleConnect}
          onEdgeClick={handleEdgeClick}
          onNodeClick={handleNodeClick}
          proOptions={{ hideAttribution: false }}
          colorMode="system"
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => (n.type === "post" ? (STATUS_RING[(n.data as PostData).post?.status] ?? "#64748b") : "#64748b")} />
        </ReactFlow>
      </div>
    </div>
  );
}

export default FleetCanvas;
