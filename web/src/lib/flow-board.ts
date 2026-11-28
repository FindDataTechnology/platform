// ── Flow board read model (add-task-flow, task 6.1) ─────────────────────────
//
// Pure logic, no fetch, no React: the same projection the web page, the mobile
// client and the miniapp render (the owner-inbox memo's "one read model, three
// clients" discipline). The server has no say in what a column means — it sends
// tasks and flows, this file decides where each card sits.
//
// Five columns, and two bypass groups that must never be folded into them:
//
//   backlog  no station or no dispatch yet    — arranging is not running
//   ready    dispatched, queued               — waiting for a slot
//   running  the engine says running          — actually executing
//   review   executed, not accepted           — the signature is missing
//   done     verdict.outcome === "pass"       — only a ruling gets here
//
//   failed   failed / interrupted             — retryable, not done
//   not_executed skipped, with its reason     — a deliberate non-run
//
// `done` is reached ONLY through a verdict. "The turn finished" is `review`,
// and that single mapping is the entire reason this feature exists.

import type { FlowCard, FlowStation } from "./types";

export type BoardColumn = "backlog" | "ready" | "running" | "review" | "done";
export type BypassGroup = "failed" | "not_executed";

export const COLUMNS: BoardColumn[] = ["backlog", "ready", "running", "review", "done"];
export const BYPASS_GROUPS: BypassGroup[] = ["failed", "not_executed"];

export interface BoardCard extends FlowCard {
  /** Human-readable blockers (task ids resolve to card titles where known). */
  blockedByTitles: string[];
  /** True while any declared blocker has not passed acceptance. */
  blocked: boolean;
}

export interface BoardModel {
  columns: Record<BoardColumn, BoardCard[]>;
  bypass: Record<BypassGroup, BoardCard[]>;
  /** Queue depth as the engine reports it, not a client-side count. */
  queueDepth: number | null;
  /** Non-null when the executor refused work for a resource reason. */
  admissionRefusal: { used: number | null; limit: number | null; message: string } | null;
}

const isPassed = (c: FlowCard) => c.flow?.verdict?.outcome === "pass";

/** Which column a card belongs to. Exported so a test can pin the mapping. */
export function columnOf(card: FlowCard): BoardColumn | BypassGroup {
  const state = card.state ?? null;

  // A ruling outranks everything: once accepted, the card is done even if a
  // later execution happened to fail. The verdict is what a human signed.
  if (isPassed(card)) return "done";

  if (state === "failed" || state === "interrupted") return "failed";
  if (state === "skipped") return "not_executed";

  if (state === "running") return "running";

  // Everything below ran (or is queued) but has no passing verdict, so it is
  // waiting for a signature — NOT done. This is the line the whole change
  // turns on.
  if (state === "done") return "review";

  // queued, or no dispatch yet. A card with a station but which never left
  // backlog is `ready` only once it has been dispatched; `flow.dispatchedAt` is
  // the marker (set by the dispatch verb), because state alone cannot tell
  // "never dispatched" from "queued and waiting".
  if (card.flow?.dispatchedAt) return "ready";
  return "backlog";
}

/**
 * Build the board from the two read surfaces. Cards keep the order the server
 * sent them; sorting is a UI concern and a client-side sort here would be a
 * second ordering rule to keep in sync.
 */
export function buildBoard({
  cards = [],
  queueDepth = null,
  admissionRefusal = null,
}: {
  cards: FlowCard[];
  queueDepth?: number | null;
  admissionRefusal?: BoardModel["admissionRefusal"];
}): BoardModel {
  const columns: Record<BoardColumn, BoardCard[]> = { backlog: [], ready: [], running: [], review: [], done: [] };
  const bypass: Record<BypassGroup, BoardCard[]> = { failed: [], not_executed: [] };
  const titleById = new Map(cards.map((c) => [c.id, c.title || c.prompt || c.id]));

  for (const card of cards) {
    const blockers = card.blockedBy ?? [];
    const blockedByTitles = blockers.map((b) => titleById.get(b) ?? b);
    // A blocker that is gone from the board does not unblock — an unknown
    // blocker is treated as unmet, because the alternative is a card silently
    // running ahead of work nobody can see.
    const blocked = blockers.some((b) => {
      const other = cards.find((c) => c.id === b);
      return !other || !isPassed(other);
    });
    const decorated: BoardCard = { ...card, blockedByTitles, blocked };
    const where = columnOf(card);
    if (where === "failed" || where === "not_executed") bypass[where].push(decorated);
    else columns[where].push(decorated);
  }

  return { columns, bypass, queueDepth, admissionRefusal };
}

/**
 * The consequence sentence shown on a review card, derived from the station's
 * OWN criteria and the last evaluation — never authored by the executor.
 *
 * Same discipline as owner-inbox's "批了之后会怎样": the text is computed from
 * the fields the accept callback actually reads, so copy and behaviour cannot
 * drift apart.
 */
export function acceptConsequence(card: FlowCard, station: FlowStation | undefined): string {
  const criteria = station?.acceptance ?? card.flow?.acceptance ?? [];
  if (criteria.length === 0) {
    return "该站点未声明验收判据：签收将以你的名义记录，可被审计。";
  }
  const judged = criteria.filter((c) => c.kind === "llm-judged").length;
  const machine = criteria.length - judged;
  const parts: string[] = [];
  if (machine > 0) parts.push(`${machine} 条机器判据（读产物与执行记录）`);
  if (judged > 0) parts.push(`${judged} 条判据型断言（模型读取，单条计费）`);
  return `签收将按 ${parts.join(" + ")} 求值；全部通过才进入已完成。`;
}

/**
 * Whether the "N cards withheld" line belongs on screen.
 *
 * Three states, not two: `undefined` (an older server that never sent the field)
 * must not read as zero, and zero must not render a line that says nothing —
 * a notice that is always present stops being read. Exported so a test can pin
 * all three without a DOM harness (this repo has none).
 */
export function unscopedNotice(count: number | null | undefined): number | null {
  return typeof count === "number" && count > 0 ? count : null;
}

/**
 * Milliseconds to wait before honouring a live-refresh signal: 0 = read now,
 * >0 = schedule one read that far ahead.
 *
 * A busy fleet fires many task broadcasts a minute; without this the board would
 * re-read once per broadcast. Pure so the throttle is testable without a DOM —
 * the page only wires the timer.
 */
export function refreshDelay(lastFetchAt: number, now: number, minGapMs = 2000): number {
  const elapsed = now - lastFetchAt;
  return elapsed >= minGapMs ? 0 : minGapMs - elapsed;
}

/** The row a card without a station lands in. Explicit, never a named station. */
export const UNASSIGNED_STATION = "__unassigned__";

export interface BoardLane {
  /** `${flowId}::${stationId}` — never just the station, because two flows can
   *  both declare a "draft" station and merging them would answer a question
   *  nobody asked. */
  key: string;
  flowId: string | null;
  stationId: string | null;
  label: string;
  board: BoardModel;
}

/**
 * The same board, cut into one row per (flow, station).
 *
 * It is a PURE projection of `buildBoard`: each lane's board is built from the
 * lane's own cards, so a card's column is identical to the flat view by
 * construction — there is no second mapping to drift. Lanes with no cards are
 * omitted (the flow declaration already lists every station, so an empty row
 * carries no information); the unassigned lane appears only when some card has
 * no station, and it is labelled as such rather than folded into a real one.
 */
export function buildLanes({
  cards = [],
  flows = [],
  queueDepth = null,
  admissionRefusal = null,
}: {
  cards: FlowCard[];
  flows: { flowId: string; name: string; stations: { stationId: string; label?: string | null }[] }[];
  queueDepth?: number | null;
  admissionRefusal?: BoardModel["admissionRefusal"];
}): BoardLane[] {
  const groups = new Map<string, { flowId: string | null; stationId: string | null; cards: FlowCard[] }>();
  for (const card of cards) {
    const flowId = card.flow?.flowId ?? null;
    const stationId = card.flow?.stationId ?? null;
    const key = `${flowId ?? ""}::${stationId ?? UNASSIGNED_STATION}`;
    const g = groups.get(key) ?? { flowId, stationId, cards: [] };
    g.cards.push(card);
    groups.set(key, g);
  }

  const lanes: BoardLane[] = [];
  for (const [key, g] of groups) {
    const flow = flows.find((f) => f.flowId === g.flowId);
    const station = flow?.stations.find((s) => s.stationId === g.stationId);
    const label = g.stationId
      ? [flow?.name ?? g.flowId, station?.label ?? g.stationId].filter(Boolean).join(" · ")
      : [flow?.name ?? g.flowId, ""].filter(Boolean).join(" · ");
    lanes.push({
      key,
      flowId: g.flowId,
      stationId: g.stationId,
      label,
      board: buildBoard({ cards: g.cards, queueDepth, admissionRefusal }),
    });
  }

  // Deterministic order: real lanes by declaration order (flow, then station),
  // the unassigned lane last. A map-iteration order would reshuffle rows as
  // cards come and go.
  const flowOrder = new Map(flows.map((f, i) => [f.flowId, i]));
  const stationOrder = new Map(
    flows.flatMap((f) => f.stations.map((s, i) => [`${f.flowId}::${s.stationId}`, i] as const)),
  );
  lanes.sort((a, b) => {
    const au = a.stationId === null ? 1 : 0;
    const bu = b.stationId === null ? 1 : 0;
    if (au !== bu) return au - bu;
    const af = flowOrder.get(a.flowId ?? "") ?? Number.MAX_SAFE_INTEGER;
    const bf = flowOrder.get(b.flowId ?? "") ?? Number.MAX_SAFE_INTEGER;
    if (af !== bf) return af - bf;
    return (stationOrder.get(`${a.flowId}::${a.stationId}`) ?? 0) - (stationOrder.get(`${b.flowId}::${b.stationId}`) ?? 0);
  });
  return lanes;
}

/**
 * A flow id derived from a display name. The server validates ids against
 * `^[a-z0-9][a-z0-9_-]{0,63}$` (ids are addressed in URLs and dependency keys),
 * so a Chinese name cannot be the id — it has to be typed or derived. Here the
 * derivation is deliberately weak: keep ASCII alphanumerics, dash everything
 * else, and fall back to a caller-supplied default. The form lets the operator
 * correct it, because a silently mangled id is one two callers disagree about.
 */
export function flowSlugFromName(name: string, fallback = "flow"): string {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return /^[a-z0-9]/.test(slug) ? slug : fallback;
}

/** The minimum a station needs before it is worth sending to the server. */
export interface StationDraft {
  label: string;
  kind: string;
  ref: string;
}

export interface DeclarationDraft {
  name: string;
  flowId: string;
  station: StationDraft;
}

/**
 * The declaration body for `PUT /api/flows/:flowId`. Shape only — every rule
 * (id charset, target kind, acceptance) is the SERVER's to enforce, and its
 * structured errors are shown verbatim in the form. Re-implementing validation
 * here would be a second rulebook that drifts.
 */
export function buildFlowDeclaration(draft: DeclarationDraft) {
  return {
    flowId: draft.flowId.trim(),
    name: draft.name.trim(),
    stations: [
      {
        stationId: flowSlugFromName(draft.station.label, "station"),
        label: draft.station.label.trim(),
        target: { kind: draft.station.kind, ref: draft.station.ref.trim() || null },
        acceptance: [],
      },
    ],
  };
}

/**
 * Completion economics for one card (run-card-bridge).
 *
 * Three values, each read from the card itself; nothing is estimated here.
 * `cost` stays `null` until the unified ledger read surface is wired — a token
 * count is not a price, so it must not be turned into one.
 */
export interface CompletionReadout {
  duration_s: number | null;
  quality: "pass" | "fail" | "unknown";
  cost: { usd: number | null; tokens: number | null; reason: string | null };
}

function totalTokens(history: FlowCard["history"] = []): number | null {
  let sum = 0;
  let seen = false;
  for (const entry of history ?? []) {
    const tokens = entry?.tokens;
    const value =
      typeof tokens === "number"
        ? tokens
        : typeof tokens?.total === "number"
          ? tokens.total
          : typeof tokens?.prompt === "number" || typeof tokens?.completion === "number"
            ? (tokens.prompt ?? 0) + (tokens.completion ?? 0)
            : null;
    if (value !== null && Number.isFinite(value)) {
      sum += value;
      seen = true;
    }
  }
  return seen ? sum : null;
}

export function completionReadout(card: FlowCard): CompletionReadout {
  const flow = card.flow ?? null;
  const staked = flow?.stakedAt ? Date.parse(flow.stakedAt) : Number.NaN;
  const ruled = flow?.verdict?.at ? Date.parse(flow.verdict.at) : Number.NaN;
  const duration_s =
    Number.isFinite(staked) && Number.isFinite(ruled) && ruled >= staked ? (ruled - staked) / 1000 : null;

  const outcome = flow?.verdict?.outcome;
  const quality = outcome === "pass" ? "pass" : outcome === "returned" ? "fail" : "unknown";

  // USD is the billing truth when the server attributed this card's execution
  // window to sub2api usage rows. Otherwise it stays null with the server's
  // reason; tokens remain the objective fallback.
  const usd = Number.isFinite(card.cost_usd) ? (card.cost_usd as number) : null;
  return {
    duration_s,
    quality,
    cost: {
      usd,
      tokens: totalTokens(card.history),
      reason: usd !== null ? null : card.cost_unknown_reason ?? "usd not attributed",
    },
  };
}
