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
