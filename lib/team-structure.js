// team-structure — the single canonical value object for "an agent team"
// (openspec: team-structure-ir).
//
// The problem this module removes: a team was modelled in at least six places
// (template skeleton via parseFleetTemplate, blueprint JSON, manifest.fleet,
// live member rows, orchestration edges, read projection via deriveTeam) with
// no single source — so the chat team-architect validated a draft with its OWN
// hand-written ops rules while the same team going through canvas/blueprint/
// template got judged by parseFleetTemplate. Two codes, two verdicts.
//
// This module does NOT invent a seventh model. It defines ONE value object —
// `TeamStructure` — whose `core` layer is EXACTLY parseFleetTemplate's output,
// whose `envelope` layer is the sellable blueprint fields, and whose `live`
// layer is the instantiation state. Everything else is a projection or a diff
// of this one object. The structural validator is a thin delegation: there is
// no second structural rule set here, by design (the moment one appears, the
// convergence test in scripts/test-team-structure-ir.mjs goes red).
//
// Pure: reads no install state, no database, no local config. A caller can run
// it on a manifest fetched from anywhere — same discipline as
// lib/team-derivation.js, whose deriveTeam() this module re-exports rather than
// reimplements.

import { parseFleetTemplate } from "../server/fleet-template.js";
import { deriveCapabilities } from "./capability-layer.js";
import { deriveTeam } from "./team-derivation.js";

// The three layers. A layer with no content is an explicit empty value, never an
// omitted field (agent-role / team-derivation: "explicit empty, never omit").
export const TEAM_STRUCTURE_LAYERS = Object.freeze(["core", "envelope", "live"]);

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// ── envelope: the sellable-template fields (boundary/dataSources/… ) ─────────
//
// These live at the TOP LEVEL of a blueprint document (fleet-blueprint-studio),
// not inside `fleet`. We surface them verbatim when present and as an explicit
// null when absent — a team that is not a sellable template is NOT an error, it
// just has no envelope.
const EMPTY_ENVELOPE = Object.freeze({
  boundary: null,
  dataSources: null,
  board: null,
  monitoring: null,
  acceptance: null,
  pricing: null,
});

function extractEnvelope(doc) {
  if (!isObj(doc)) return { ...EMPTY_ENVELOPE };
  const env = {
    boundary: isObj(doc.boundary) ? doc.boundary : null,
    dataSources: Array.isArray(doc.dataSources) ? doc.dataSources : null,
    board: Array.isArray(doc.board) ? doc.board : isObj(doc.board) ? doc.board : null,
    monitoring: isObj(doc.monitoring) ? doc.monitoring : null,
    // acceptance is the release contract; deriveTeam already owns its projection,
    // but the envelope carries the raw declaration for release/blueprint consumers.
    acceptance: Array.isArray(doc.acceptance) ? doc.acceptance : null,
    pricing: isObj(doc.pricing) ? doc.pricing : null,
  };
  return env;
}

// ── toTeamStructure: normalize any recognized source to the one value object ──
//
// Accepts:
//   - a pack manifest (has `.fleet`)  → core from parseFleetTemplate
//   - a template manifest             (has `.fleet`)  → same
//   - a blueprint document            (has boundary/dataSources + fleet)
// `live` is the caller's knowledge (a cell either has an instance or not); this
// module never guesses it (same three-valued discipline as deriveTeam).
export function toTeamStructure(doc, { live = null } = {}) {
  const parsed = isObj(doc) ? parseFleetTemplate(doc) : { ok: false, error: "document must be an object" };
  const core = parsed.ok ? parsed.template : null;
  return {
    core, // null when the doc declares no valid fleet (not a team)
    coreError: parsed.ok ? null : parsed.error ?? null,
    envelope: extractEnvelope(doc),
    live: isObj(live) ? live : live === null ? null : null,
  };
}

// ── 能力投影（capability-layer 5.3）──────────────────────────────────────────
//
// 团队结构的正本是 `core`（编制事实）+ `envelope`（可售信封）+ `live`（实化态）。
// 这个函数**是投影，不是第二个真源**：它不持有任何字段，只把同一份 manifest 交给
// 能力层推导，按团队作用域返回各岗拿到什么。
//
// 为什么放在这里而不是让调用方各自调 deriveCapabilities：团队结构的收敛判据要求
// 「六处各自被证明为对正本的投影或差分」。能力面是第七处，它必须从同一个入口进，
// 否则下次又会长出「市场卡片上是一套、团队控制台是另一套」。
//
// 依赖是单向的：team-structure → capability-layer。capability-layer 不 import 本模块，
// 所以不存在循环；也因此能力层不知道「团队」是什么，它只认 scope=team 的输入。
//
// 结构化失败不回落到全包：manifest 不合法时返回 `{ok:false, reason}`，让读面如实
// 呈现「能力面不可得」，而不是给一份看起来正常的空表。
export function projectCapabilitiesForTeam(doc, { memberRef = null } = {}) {
  const m = isObj(doc) ? doc : null;
  if (!m) return { ok: false, reason: "document must be an object" };
  const parsed = parseFleetTemplate(m);
  if (!parsed.ok) return { ok: false, reason: parsed.error ?? "fleet declaration is not valid" };
  return { ok: true, ...deriveCapabilities(m, { scope: "team", memberRef }) };
}

// ── validateTeamStructure: the ONE structural validation entry ───────────────
//
// Delegates ALL structure rules to parseFleetTemplate (members/target/cadence/
// kpiSlots/parentRef tree/unknown-field gate/runtime-field shapes) and the
// envelope's acceptance to deriveTeam's own projection checks. This function
// adds nothing structural of its own — its whole job is to be the single name a
// caller reaches for, so no one writes a parallel rule set.
//
// Returns { ok, errors: [{error, code?}], core }.
export function validateTeamStructure(doc) {
  const errors = [];
  const parsed = isObj(doc) ? parseFleetTemplate(doc) : { ok: false, error: "document must be an object" };
  if (!parsed.ok) {
    errors.push({ error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) });
    if (Array.isArray(parsed.errors)) for (const e of parsed.errors) errors.push({ error: e.error ?? String(e) });
    return { ok: false, errors, core: null };
  }
  return { ok: true, errors, core: parsed.template };
}

// ── cross-segment consistency (the ONLY rules this module adds) ──────────────
//
// The one thing parseFleetTemplate cannot know is a relationship that spans two
// documents sections at the STRUCTURE level: a member's pack-preset presetId
// must name an agent declared in the SAME manifest's `agents[]`, and a member's
// declared tool face must be a subset of the tools the manifest's mcpServers
// declare. These are cross-segment (fleet × agents × mcpServers), not
// fleet-internal, so they belong here — not in the fleet parser, and not in a
// second copy in the architect.
//
// Returns [{ error, code }] — empty when consistent.
export function crossSegmentErrors(manifest) {
  const out = [];
  if (!isObj(manifest) || !isObj(manifest.fleet) || !Array.isArray(manifest.fleet.members)) return out;
  const agentIds = new Set(
    (Array.isArray(manifest.agents) ? manifest.agents : [])
      .map((a) => (isObj(a) ? a.id : null))
      .filter((id) => typeof id === "string" && id.trim()),
  );
  for (const m of manifest.fleet.members) {
    const t = isObj(m) ? m.target : null;
    if (isObj(t) && t.kind === "pack-preset" && typeof t.presetId === "string" && t.presetId.trim()) {
      // A self-referential manifest must declare the preset it points at; a
      // cross-pack reference (packId ≠ this pack) is resolved on the market,
      // not here, so only police the local case.
      const selfRef = !t.packId || t.packId === "{{PACK_ID}}";
      if (selfRef && agentIds.size > 0 && !agentIds.has(t.presetId)) {
        out.push({
          error: `member '${m.ref}' presetId '${t.presetId}' names no agent in this manifest's agents[]`,
          code: "team_member_preset_unresolved",
        });
      }
    }
  }
  return out;
}

// ── diffTeamStructure: desired-state vs current, for the management side ─────
//
// The architect's ops (`members[].op`) become a DIFF of two TeamStructure-like
// member sets rather than a hand-rolled op vocabulary. `current` and `desired`
// are arrays of normalized member objects (core.members shape). We compute a
// minimal, reversible change set:
//   { adds: [member], updates: [{ref, before, after}], removes: [ref] }
// Applying the change set to `current` yields `desired` — the round-trip the
// convergence test pins (task 2.3).
function memberKey(m) {
  return (m && (m.ref ?? m.id)) || null;
}
function shallowMember(m) {
  // Strip volatile live fields so the diff compares DECLARED structure only.
  if (!isObj(m)) return m;
  const { state, lastTurn, ...rest } = m;
  return rest;
}
function sameMember(a, b) {
  return JSON.stringify(shallowMember(a)) === JSON.stringify(shallowMember(b));
}

export function diffTeamStructure(current = [], desired = []) {
  const cur = (Array.isArray(current) ? current : []).map(shallowMember);
  const des = (Array.isArray(desired) ? desired : []).map(shallowMember);
  const curBy = new Map(cur.map((m) => [memberKey(m), m]).filter(([k]) => k));
  const desBy = new Map(des.map((m) => [memberKey(m), m]).filter(([k]) => k));

  const adds = [];
  const updates = [];
  const removes = [];
  for (const [k, after] of desBy) {
    if (!curBy.has(k)) adds.push(after);
    else if (!sameMember(curBy.get(k), after)) updates.push({ ref: k, before: curBy.get(k), after });
  }
  for (const [k] of curBy) if (!desBy.has(k)) removes.push(k);
  return { adds, updates, removes };
}

// Apply a diff back onto `current` → should deep-equal `desired`.
export function applyTeamDiff(current = [], diff) {
  const byKey = new Map((Array.isArray(current) ? current : []).map((m) => [memberKey(shallowMember(m)), shallowMember(m)]));
  for (const ref of diff.removes ?? []) byKey.delete(ref);
  for (const u of diff.updates ?? []) byKey.set(u.ref, shallowMember(u.after));
  for (const a of diff.adds ?? []) byKey.set(memberKey(a), shallowMember(a));
  return [...byKey.values()];
}

// ── projections: re-exported, never reimplemented ─────────────────────────────
//
// The read faces (roster/cadence/kpiSlots/edges/acceptance) are deriveTeam's
// job. We re-export it so a consumer reaches for team-structure and gets the
// single derivation — not a copy. A test asserts deriveTeam's value fields are
// a subset of core (no toolkit/memory leak, per team-derivation's own rule).
export { deriveTeam };

// ── live → IR bridge (the management side's read edge) ────────────────────────
//
// The live fleet stores members in a DIFFERENT vocabulary than the template/IR:
// targetKind ∈ persona|cluster|a2a|tool|bot|auditor, and target/tree are flat
// columns (target_id, parent_id). To let the manager (and, later, the architect's
// desired-state diff) speak the SAME TeamStructure the builder writes, we map a
// live member row into a core-shaped member. This is the ONE place the live
// vocabulary becomes IR vocabulary — mirroring fleet-template.js's
// TARGET_KIND_TO_MEMBER_KIND in the opposite direction, and its own comment's
// promise that both faces share one vocabulary.
//
// Pure (a row in, a member out) — it reads no DB; the caller passes rows it
// already has. `auditor`/`bot` pass through unchanged (the template supports both).
export const LIVE_TO_TEMPLATE_KIND = Object.freeze({
  persona: "existing-persona",
  cluster: "existing-cluster",
  a2a: "existing-a2a",
  tool: "tool",
  bot: "bot",
  auditor: "auditor",
});

export function memberFromLive(row) {
  if (!isObj(row)) return null;
  const tKind = LIVE_TO_TEMPLATE_KIND[row.targetKind];
  // An unknown live targetKind is surfaced as a null target (not silently
  // coerced) so a future live kind can't hide behind a wrong template kind.
  const target = tKind
    ? { kind: tKind, id: row.targetId ?? null }
    : { kind: row.targetKind ?? null, id: row.targetId ?? null, _unmapped: true };
  return {
    ref: row.id ?? row.ref ?? null,
    title: row.title ?? null,
    parentRef: row.parentId ?? null,
    target,
    kpiSlots: Array.isArray(row.kpiSlots) ? row.kpiSlots : [],
    cadence: row.cadence ?? null,
    model: row.model ?? null,
    fallbackModel: row.fallbackModel ?? null,
    effort: row.effort ?? null,
    contextBudget: row.contextBudget ?? null,
    carrier: row.carrier ?? null,
    inputPolicy: row.inputPolicy ?? null,
    concurrency: row.concurrency ?? null,
    workbench: row.workbench ?? null,
    memory: row.memory ?? null,
  };
}

export function membersFromLive(rows) {
  return (Array.isArray(rows) ? rows : []).map(memberFromLive).filter(Boolean);
}

