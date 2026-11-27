// builder-taxonomy — the ONE classification of what a Builder produces
// (openspec: builder-structure-convergence).
//
// Four producers, four artifact shapes, and until now no table saying "find
// whom, get what, is it a team". That ambiguity is the original complaint.
// This module is a frozen table plus pure functions:
//
//   team-live      → fleet-architect     → live fleet ops      → IS team
//   team-template  → blueprint-architect → blueprint/template  → IS team
//   expert-pack    → pack-author         → pack manifest       → NOT team
//   facade-pack    → facade-builder      → facade pack         → NOT team
//
// Two things are load-bearing here:
//   1. `convergeTeamCore` proves the TWO team producers describe the same team
//      with the same core — so "template vs live" is a representation choice,
//      not a second truth. (The fleet-architect VALIDATION code flip is change
//      unify-team-structure-ir task 3.x, which needs CI e2e — not duplicated.)
//   2. `expert-pack`/`facade-pack` are explicitly NOT teams: they are never
//      required to declare `fleet`, and never rendered as an empty roster.
//
// Pure: no DB, no install state. Reads only the structures passed in.

import { parseFleetTemplate } from "../server/fleet-template.js";
import { membersFromLive } from "./team-structure.js";

// ── the taxonomy (frozen) ────────────────────────────────────────────────────
export const BUILDER_PRODUCT_TYPES = Object.freeze({
  "team-live": Object.freeze({ producer: "fleet-architect", artifact: "live-fleet", isTeam: true }),
  "team-template": Object.freeze({ producer: "blueprint-architect", artifact: "blueprint", isTeam: true }),
  "expert-pack": Object.freeze({ producer: "pack-author", artifact: "pack-manifest", isTeam: false }),
  "facade-pack": Object.freeze({ producer: "facade-builder", artifact: "facade-pack", isTeam: false }),
});

export const TEAM_PRODUCT_TYPES = Object.freeze(
  Object.keys(BUILDER_PRODUCT_TYPES).filter((k) => BUILDER_PRODUCT_TYPES[k].isTeam),
);
export const NON_TEAM_PRODUCT_TYPES = Object.freeze(
  Object.keys(BUILDER_PRODUCT_TYPES).filter((k) => !BUILDER_PRODUCT_TYPES[k].isTeam),
);

// Unknown kinds return an explicit "unregistered" answer, never the nearest type
// — a silent nearest-match is how "expert" quietly becomes "team".
export function classifyArtifact(kind) {
  const entry = Object.hasOwn(BUILDER_PRODUCT_TYPES, kind) ? BUILDER_PRODUCT_TYPES[kind] : null;
  return entry ? { ...entry, kind, registered: true } : { kind, registered: false, isTeam: false, producer: null, artifact: null };
}

export function isTeamType(kind) {
  return Object.hasOwn(BUILDER_PRODUCT_TYPES, kind) && BUILDER_PRODUCT_TYPES[kind].isTeam === true;
}

export function producerForType(kind) {
  return classifyArtifact(kind).producer;
}

// ── convergence: the same team described two ways → one core ─────────────────

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// Canonical execution-body identity, so a template's self-referential
// `pack-preset` and a live `existing-persona` that name the SAME agent compare
// equal (design D2: reference-form difference is not a convergence failure).
function targetIdentity(target) {
  if (!isObj(target)) return null;
  const id = target.presetId ?? target.id ?? null;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

// Normalize the fields both sides can honestly carry on a member row.
//
// `memory` (per-post charter) is deliberately EXCLUDED: it is not a member
// column — the provisioner writes it into the agent document's
// `memory.guidance` (fleet-member-config owns that path and its two-path
// evidence). Comparing it from member rows would always differ, which is a data
// location fact, not a convergence defect.
function normalizeCadence(c) {
  if (!isObj(c) || typeof c.cron !== "string" || !c.cron.trim()) return null;
  return {
    cron: c.cron,
    tz: c.tz ?? null,
    promptTemplate: c.promptTemplate ?? null,
    turnTimeoutMs: Number.isFinite(c.turnTimeoutMs) ? c.turnTimeoutMs : null,
  };
}
function normalizeSlots(slots) {
  return (Array.isArray(slots) ? slots : [])
    .filter(isObj)
    .map((s) => ({ key: s.key ?? null, label: s.label ?? null, unit: s.unit ?? null }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
}
function normalizeMember(m) {
  return {
    target: targetIdentity(m?.target),
    title: m?.title ?? null,
    parentRef: m?.parentRef ?? null,
    cadence: normalizeCadence(m?.cadence),
    kpiSlots: normalizeSlots(m?.kpiSlots),
    model: m?.model ?? null,
    fallbackModel: m?.fallbackModel ?? null,
    effort: m?.effort ?? null,
    contextBudget: Number.isFinite(m?.contextBudget) ? m.contextBudget : null,
    carrier: m?.carrier ?? null,
    inputPolicy: m?.inputPolicy ?? null,
    concurrency: m?.concurrency ?? null,
    workbench: m?.workbench ?? null,
  };
}

const COMPARED_FIELDS = Object.freeze(Object.keys(normalizeMember({})));

// Compare one field; returns null when equal, a {field, template, live} when not.
function fieldDiff(ref, field, t, l) {
  return JSON.stringify(t[field]) === JSON.stringify(l[field]) ? null : { ref, field, template: t[field], live: l[field] };
}

/**
 * convergeTeamCore({ templateManifest, liveRows })
 *
 * Returns:
 *   { isTeam: false, reason }                      — the input is not a team type
 *   { isTeam: true, ok: false, errors: [string] }  — the template is not a valid team
 *   { isTeam: true, ok: true, equal, diffs: [] }   — both cores, field-compared
 */
export function convergeTeamCore({ templateManifest = null, liveRows = [] } = {}) {
  const parsed = isObj(templateManifest) ? parseFleetTemplate(templateManifest) : { ok: false, error: "no template manifest" };
  if (!parsed.ok) {
    return { isTeam: true, ok: false, errors: [{ error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) }] };
  }
  const templateMembers = new Map(parsed.template.members.map((m) => [m.ref, normalizeMember(m)]));
  const liveMembers = new Map(membersFromLive(liveRows).map((m) => [m.ref, normalizeMember(m)]));

  const diffs = [];
  // Structural presence first: a post only one side has is the loudest drift.
  for (const ref of templateMembers.keys()) {
    if (!liveMembers.has(ref)) diffs.push({ ref, field: "presence", template: "present", live: "absent" });
  }
  for (const ref of liveMembers.keys()) {
    if (!templateMembers.has(ref)) diffs.push({ ref, field: "presence", template: "absent", live: "present" });
  }
  for (const [ref, t] of templateMembers) {
    const l = liveMembers.get(ref);
    if (!l) continue;
    for (const field of COMPARED_FIELDS) {
      const d = fieldDiff(ref, field, t, l);
      if (d) diffs.push(d);
    }
  }
  return { isTeam: true, ok: true, equal: diffs.length === 0, diffs, comparedFields: [...COMPARED_FIELDS] };
}
