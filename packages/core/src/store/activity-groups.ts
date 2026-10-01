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
