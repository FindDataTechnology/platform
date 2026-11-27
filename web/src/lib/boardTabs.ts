// Board tab rules (unify-line-board-tabs). Pure functions, in lib/ so
// node --test can import them directly — the page owns painting, not policy.
// Precedent: lib/tabsCore.ts exists for the same reason.

import type { BlockLike } from "./boardTabsTypes"

/** Lines that are the host itself rather than an external product line.
 *  A board there would be the platform looking at itself, so the page says
 *  exactly that instead of the "not onboarded yet" wording that sends the
 *  reader looking for a connector which will never exist. */
export const HOST_LINES: ReadonlySet<string> = new Set(["base"])

/** The tab set a board renders, straight from the response the adapter built.
 *  The page keeps no table of its own: a page-side list and an adapter-side
 *  list are two sources, and two sources drift silently (lex's four tabs were
 *  shipped by the adapter and never reached the page). */
export function tabsOf(data: { tabs?: string[] } | null | undefined): string[] {
  const tabs = data?.tabs
  return Array.isArray(tabs) ? tabs : []
}

/** A line whose every block is the honest "no upstream yet" sentinel has
 *  nothing to page through — one statement, not N identical ones. 萬星's three
 *  tabs each rendered the same 建设中 line, so the reader clicked three times
 *  to learn nothing twice more. */
export function whollyUnderConstruction(blocks: BlockLike[] | null | undefined): boolean {
  const list = blocks ?? []
  return list.length > 0 && list.every((b) => b?.error === "under_construction")
}

/** True when the board should render a tab strip at all: more than one tab,
 *  and not a wholly under-construction line (which is collapsed upstream of
 *  the strip). A single-tab board renders its block directly. */
export function showsTabStrip(blocks: BlockLike[] | null | undefined, tabs: string[]): boolean {
  return tabs.length > 1 && !whollyUnderConstruction(blocks)
}
