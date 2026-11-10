// Activity grouping — the derivation behind the master collapse of an
// assistant turn's machinery (thinking / tool / skill).
//
// Groups are DERIVED, never persisted: a group is a maximal run of
// consecutive non-text blocks, identified by the run's start block index
// (stable while streaming — a run only grows at its tail, and a new run only
// appears when a text block lands). Only the user's open/closed overrides are
// stored, on the turn (`groupState`); everything else re-derives, which is
// what lets history replay and the mini-program get the same behavior for
// free. `error` blocks and `command` blocks are deliberately not group
// members — errors must never hide behind a collapsed header, and a command
// echo (`/model`, `/preset`, …) is the user-invoked action's whole feedback,
// not machinery.

import type { Block, Turn } from "./chat-store";

export type AssistantTurn = Extract<Turn, { role: "assistant" }>;

export interface ActivityGroup {
  // Block index where the run starts — the key under which the turn's
  // `groupState` stores a user override.
  startIndex: number;
  blocks: Block[];
}

const GROUP_KINDS = new Set(["thinking", "tool", "skill"]);

// Maximal runs of consecutive groupable blocks, in block order. A text (or
// error) block breaks a run; leading/trailing machinery each form their own.
export function groupTurnBlocks(blocks: Block[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let start = -1;
  for (let i = 0; i <= blocks.length; i++) {
    const b = blocks[i];
    const groupable = b !== undefined && GROUP_KINDS.has(b.kind);
    if (groupable && start < 0) start = i;
    if (!groupable && start >= 0) {
      groups.push({ startIndex: start, blocks: blocks.slice(start, i) });
      start = -1;
    }
  }
  return groups;
}

// The group's effective open state: an explicit user override wins; otherwise
// collapsed, EXCEPT a group holding an errored tool defaults open (mirrors
// the per-block rule — failures are never folded away).
export function isGroupOpen(turn: AssistantTurn, group: ActivityGroup): boolean {
  const override = turn.groupState?.[group.startIndex];
  if (override !== undefined) return override;
  return groupHasError(group);
}

export function groupHasError(group: ActivityGroup): boolean {
  return group.blocks.some((b) => b.kind === "tool" && b.state === "error");
}

// A group holding the LIVE ask must not hide the question card behind a
// collapsed header: while the ask waits for the human, the group renders
// expanded (the same never-fold-it-away rule errored activity already
// follows). The pending ask lives in store state, not in the blocks, so
// surfaces composite this onto isGroupOpen — that function stays pure over
// turn/group.
export function groupHasPendingAsk(
  group: ActivityGroup,
  pending: { toolCallId?: string } | null,
): boolean {
  if (pending === null) return false;
  return group.blocks.some(
    (b) =>
      b.kind === "tool" &&
      b.name === "ask_user_question" &&
      b.state === "running" &&
      (pending.toolCallId === undefined || pending.toolCallId === b.id),
  );
}

// The action gate's propose_action call. dsh names MCP tools
// `mcp__<server>__<tool>`, so the match is on the suffix — a strict compare
// against a bare name never fires on the wire (copilot-dock-focused-preset
// acceptance, 2026-10-22).
export function isProposeActionBlock(b: Block): b is Extract<Block, { kind: "tool" }> {
  return b.kind === "tool" && b.name.endsWith("__propose_action");
}

// The proposal state inside a propose_action result: the MCP child's JSON text
// or an already-parsed object (the store may or may not have parsed it — the
// action card accepts both, so this must too). null when it is not a proposal.
export function proposalStateOf(result: unknown): string | null {
  if (!result) return null;
  if (typeof result === "string") {
    try {
      return proposalStateOf(JSON.parse(result));
    } catch {
      return null;
    }
  }
  if (typeof result !== "object") return null;
  const r = result as { proposalId?: unknown; state?: unknown };
  if (typeof r.proposalId !== "string") return null;
  return typeof r.state === "string" ? r.state : "pending";
}

// A proposal still waiting for the human's confirm/cancel must not sit folded
// behind the collapsed header any more than a live ask: the group renders
// expanded while the call is in flight or its proposal is pending. A resolved
// card (executed / rejected / expired) folds like any finished step; a failed
// call is already covered by the errored-group rule.
export function groupHasPendingAction(group: ActivityGroup): boolean {
  return group.blocks.some((b) => {
    if (!isProposeActionBlock(b)) return false;
    if (b.state === "running") return true;
    return b.state === "done" && proposalStateOf(b.result) === "pending";
  });
}
