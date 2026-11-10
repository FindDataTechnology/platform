// workspace-canvas — the document↔canvas projection for the team workspace's
// writable graph (add-agent-builder-workspace 6.1/6.2, design D6).
//
// The document's `content.fleet` is a TEMPLATE (member refs + target kinds in
// the pack vocabulary); the live fleets page projects RUNNING members. Here we
// project the declared shape into the SAME FleetCanvas vocabulary, statically:
// every post is unborn (status "paused", no evidence) — the birth happens at
// POST /api/fleets/from-template, never here. One projection, two consumers of
// the shared canvas component (D6: 零第二造).
//
// Draft-edge application is a pure function too: confirm = merge the draft
// into content.fleet.orchestration.edges (the same shape the live
// orchestration apply face writes), then the ordinary autosave carries it
// through the EXISTING publish-gate validation chain — an illegal merge is
// rejected and the caller restores the snapshot.

import type { BlueprintContent } from "@/lib/blueprint-api";
import type { CanvasPost } from "@/components/fleet/FleetCanvas";
import type { GraphEdge } from "@/components/FleetGraph";

// Template target kinds → live member kinds (the same substitution the server's
// TARGET_KIND_TO_MEMBER_KIND table performs at provision time).
const TARGET_KIND_TO_MEMBER_KIND: Record<string, string> = {
  "pack-preset": "persona",
  "existing-persona": "persona",
  "existing-cluster": "cluster",
  "existing-a2a": "a2a",
  tool: "tool",
  bot: "bot",
};

export interface DocCanvasProjection {
  members: CanvasPost[];
  edges: GraphEdge[];
}

export function projectFleetDocCanvas(content: BlueprintContent | null): DocCanvasProjection | null {
  const fleet = content?.fleet as
    | { members?: unknown[]; orchestration?: { edges?: unknown[] } }
    | undefined;
  const rawMembers = Array.isArray(fleet?.members) ? fleet!.members : [];
  if (rawMembers.length === 0) return null;

  // Agent names (content.agents) give posts their display names when the
  // member title is bare — the pointer is the member's TARGET (an
  // existing-persona id or a pack-preset presetId), never the member ref.
  const agentNames = new Map<string, string>();
  for (const a of (content?.agents ?? []) as { id?: string; name?: string }[]) {
    if (a && typeof a.id === "string" && typeof a.name === "string") agentNames.set(a.id, a.name);
  }
  const agentNameFor = (m: { target?: { kind?: string; id?: string; presetId?: string } }): string | undefined => {
    const pointer = m.target?.kind === "pack-preset" ? m.target?.presetId : m.target?.id;
    const name = typeof pointer === "string" ? agentNames.get(pointer) : undefined;
    return name && name.trim() ? name : undefined;
  };

  const members: CanvasPost[] = rawMembers.map((m) => {
    const mm = m as { ref?: string; title?: string; target?: { kind?: string; id?: string; presetId?: string } };
    const ref = typeof mm.ref === "string" ? mm.ref : "";
    const kind = TARGET_KIND_TO_MEMBER_KIND[mm.target?.kind ?? ""] ?? "persona";
    const title = (typeof mm.title === "string" && mm.title.trim()) || agentNameFor(mm) || ref || "?";
    return {
      id: ref,
      title,
      kind,
      // Unborn: the document declares, the fleet materializes. "paused" is the
      // from-template birth state — the canvas never shows a document post as
      // live (no evidence exists to fake).
      status: "paused",
      statusReason: "",
      slots: [],
      lastRunAt: null,
      nextRunAt: null,
      cadenceEnabled: false,
      effectiveModel: null,
      modelNotice: null,
      lastTurnFailed: false,
      consecutiveFailures: 0,
      lastTurnSkipped: false,
      skippedRounds: 0,
      botType: null,
    };
  });

  const rawEdges = Array.isArray(fleet?.orchestration?.edges) ? fleet!.orchestration!.edges : [];
  const edges = rawEdges.filter(
    (e): e is GraphEdge => {
      const ee = e as { from?: string; to?: string; kind?: string; targets?: string[] };
      return typeof ee?.from === "string" && typeof ee?.to === "string" && typeof ee?.kind === "string";
    },
  );
  return { members, edges };
}

export interface DraftEdgeOp {
  kind: string;
  from: string;
  to: string;
}

export function edgeKeyOf(e: { kind?: string; from?: string; to?: string; targets?: string[] }): string {
  if (e.kind === "fanout") return `${e.from}→${(e.targets ?? []).join(",")}:fanout`;
  return `${e.from ?? ""}→${e.to ?? ""}:${e.kind ?? ""}`;
}

export function draftRemovesKey(key: string, removedKeys: string[]): boolean {
  return removedKeys.includes(key);
}

// Confirm-time merge (pure): kept (declared minus draft removals) + draft
// additions. The draft op shape mirrors the live orchestration apply face, so
// the merged edges speak the exact same vocabulary.
export function applyDraftEdgesToFleet(
  fleet: Record<string, unknown> | undefined | null,
  added: DraftEdgeOp[],
  removedKeys: string[],
): Record<string, unknown> {
  const base = (fleet ?? {}) as Record<string, unknown>;
  const orch = { ...((base.orchestration as Record<string, unknown>) ?? {}) };
  const rawEdges = Array.isArray(orch.edges) ? (orch.edges as Record<string, unknown>[]) : [];
  const kept = rawEdges.filter((e) => {
    const ee = e as { from?: string; to?: string; kind?: string; targets?: string[] };
    return !removedKeys.includes(edgeKeyOf(ee));
  });
  // Dedup on the edge key: a double confirm (or a re-adopt) must never
  // duplicate a connection.
  const seen = new Set(kept.map((e) => edgeKeyOf(e)));
  const additions = added
    .filter((d) => !seen.has(edgeKeyOf(d)))
    .map((d) => ({ kind: d.kind, from: d.from, to: d.to }));
  orch.edges = [...kept, ...additions];
  return { ...base, orchestration: orch };
}
