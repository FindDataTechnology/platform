// Fleet architect lane (agent-fleet-architect, add-fleet-architect-pack).
//
// The natural-language compile face for fleet structure in 壹座 chat: an
// architect persona drafts spec changes in conversation, this lane dry-runs
// them (validate + diff + cost estimate, nothing persisted), and applies them
// through the SAME fleet services the REST face uses (db writes + one
// reconcile — single writer, no second write path, no scheduler).
//
// Three-piece separation by design: read (list/spec/turns) → draft (dry-run)
// → apply (revalidate, then write). Approval is conversational (the persona's
// discipline, pinned in the seed prompt + tool descriptions); the structural
// backstop is apply-time revalidation — a drifted draft fails honestly.
//
// Bridge identity: loopback-only (the auth.js exemption), and the ROUTES
// resolve the acting owner from ctx.cellUserEmail — one cell is one user, the
// architect is their agent.

import { Router } from "express";
import { getFleetDatabase, isPersonaBackedTargetKind } from "./routes/fleets-db.js";
import { resolveFleetTarget } from "./routes/fleets.js";
import * as catalog from "../catalog.js";
import { reconcileFleet, cronPeriodMs } from "./fleet-reconcile.js";
import { splitToolTarget } from "./tool-turn.js";
import { rosterPresetId } from "../dsh-profile.js";
import { MODEL_ID_RE } from "../lib/pack-manifest.js";
import { validateOrchestration } from "./fleet-orchestration.js";
import * as cron from "../cron.js";

// ── tuning knobs (read per call, pack-policy convention) ────────────────────

export const SPAN_WARN = 8;

export function minPeriodWarnMinutes() {
  const n = Number(process.env.FLEET_ARCHITECT_MIN_PERIOD_MIN);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

export function tokenRange() {
  const raw = String(process.env.FLEET_ARCHITECT_TOKEN_RANGE || "3000,8000");
  const [lo, hi] = raw.split(",").map((x) => Number(x.trim()));
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi >= lo) return [lo, hi];
  return [3000, 8000];
}

const OPS = ["add", "update", "pause", "resume", "remove"];
const KINDS = ["persona", "cluster", "a2a", "tool"];

// Tool posts' deterministic contract: the cadence prompt IS the arguments.
function toolArgsError(targetKind, cadence) {
  if (targetKind !== "tool" || !cadence) return null;
  try {
    const parsed = JSON.parse(cadence.promptTemplate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  } catch {
    return "a tool post's cadence.promptTemplate must be a JSON object — it is the tool's arguments";
  }
  return null;
}

// ── validation (pure composition over injected db/resolver) ─────────────────

// Returns { ok, errors: [], warnings: [], diff: [...ops] } — errors block
// apply, warnings ride the diff. `resolver` is the same target-aliveness
// resolver the REST face uses.
export function validateFleetDraft(db, draft, { resolver = resolveFleetTarget } = {}) {
  const errors = [];
  const warnings = [];

  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return { ok: false, errors: [{ error: "draft must be an object" }], warnings, diff: [] };
  }
  const mode = draft.mode;
  if (mode !== "create" && mode !== "edit") {
    errors.push({ error: "mode must be 'create' or 'edit'" });
  }

  let fleet = null;
  if (mode === "edit") {
    fleet = db.getFleet(draft.fleetId) ?? null;
    if (!fleet) errors.push({ error: `fleet '${draft.fleetId}' not found` });
  }

  // fleet-level fields
  const name = draft.fleet?.name;
  if (mode === "create" && (typeof name !== "string" || !name.trim())) {
    errors.push({ error: "fleet.name is required for a new fleet" });
  }
  if (name !== undefined && name !== null && typeof name !== "string") {
    errors.push({ error: "fleet.name must be a string" });
  }
  const defaultModel = draft.fleet?.defaultModel ?? null;
  if (defaultModel != null && (typeof defaultModel !== "string" || !MODEL_ID_RE.test(defaultModel))) {
    errors.push({ error: "fleet.defaultModel must be a model identifier or null" });
  }
  if (mode === "edit" && draft.fleet?.name && fleet && draft.fleet.name === fleet.name && !defaultModel) {
    // A no-op rename is fine; nothing to flag.
  }

  // members
  const members = Array.isArray(draft.members) ? draft.members : [];
  if (mode === "create" && members.length === 0) {
    errors.push({ error: "a new fleet needs at least one member" });
  }
  const existing = mode === "edit" && fleet ? db.listMembers(fleet.id) : [];
  const byRef = new Map(existing.map((m) => [m.id, m]));
  const diff = [];
  let newPostCount = 0;

  const seenRefs = new Set();
  const removedRefs = new Set();
  for (const [i, op] of members.entries()) {
    const at = `members[${i}]`;
    if (!op || typeof op !== "object") {
      errors.push({ error: `${at} must be an object`, entry: at });
      continue;
    }
    if (!OPS.includes(op.op)) {
      errors.push({ error: `${at}.op must be one of ${OPS.join("|")}`, entry: at });
      continue;
    }
    if (op.op === "add") {
      newPostCount += 1;
      if (typeof op.title !== "string" || !op.title.trim()) {
        errors.push({ error: `${at}.title is required for add`, entry: at });
      }
      if (!KINDS.includes(op.targetKind)) {
        errors.push({ error: `${at}.targetKind must be one of ${KINDS.join("|")}`, entry: at });
        continue;
      }
      if (typeof op.targetId !== "string" || !op.targetId.trim()) {
        errors.push({ error: `${at}.targetId is required for add`, entry: at });
        continue;
      }
      if (op.targetKind === "tool" && !splitToolTarget(op.targetId)) {
        errors.push({ error: `${at}.targetId '${op.targetId}' must be 'server::tool'`, entry: at });
        continue;
      }
      if (!resolver({ targetKind: op.targetKind, targetId: op.targetId }).alive) {
        errors.push({ error: `${at}: target ${op.targetKind}/${op.targetId} does not exist (or is not live)`, entry: at });
      }
      // Unique-post is a persona/cluster rule; a2a targets hold many posts
      // (agent-fleet-core) — findPostByTarget is never consulted for them.
      if (op.targetKind !== "a2a") {
        const squat = db.findPostByTarget(op.targetKind, op.targetId);
        if (squat) {
          errors.push({
            error: `${at}: ${op.targetKind} '${op.targetId}' already holds a post in ${squat.fleet.name} (${squat.member.title})`,
            entry: at,
          });
        }
      }
    } else {
      const ref = op.ref;
      if (typeof ref !== "string" || !ref) {
        errors.push({ error: `${at}.ref is required for ${op.op}`, entry: at });
        continue;
      }
      const current = byRef.get(ref);
      if (!current) {
        errors.push({ error: `${at}.ref '${ref}' does not match a member of this fleet (drifted?)`, entry: at });
        continue;
      }
      // Multiple ops on one ref are legal (rename + pause in one draft) —
      // they apply sequentially. Only op-after-remove is structurally broken.
      if (removedRefs.has(ref)) {
        errors.push({ error: `${at}.ref '${ref}' was removed earlier in this draft — no ops may follow a remove`, entry: at });
        continue;
      }
      if (op.op === "remove") removedRefs.add(ref);
      if (op.op === "update") {
        if (op.targetKind && !KINDS.includes(op.targetKind)) {
          errors.push({ error: `${at}.targetKind must be one of ${KINDS.join("|")}`, entry: at });
        }
        const nextKind = op.targetKind ?? current.targetKind;
        const nextId = op.targetId ?? current.targetId;
        if ((op.targetKind || op.targetId) && (nextKind !== current.targetKind || nextId !== current.targetId)) {
          if (!nextId) {
            errors.push({ error: `${at}.targetId cannot be emptied by update`, entry: at });
          } else if (!resolver({ targetKind: nextKind, targetId: nextId }).alive) {
            errors.push({ error: `${at}: target ${nextKind}/${nextId} does not exist (or is not live)`, entry: at });
          } else {
            // a2a swaps sidestep the uniqueness scan on both ends
            const squat = nextKind === "a2a" ? null : db.findPostByTarget(nextKind, nextId, { excludeMemberId: current.id });
            if (squat) {
              errors.push({
                error: `${at}: ${nextKind} '${nextId}' already holds a post in ${squat.fleet.name} (${squat.member.title})`,
                entry: at,
              });
            }
          }
        }
        for (const key of ["model", "fallbackModel"]) {
          if (op[key] !== undefined && op[key] !== null && (typeof op[key] !== "string" || !MODEL_ID_RE.test(op[key]))) {
            errors.push({ error: `${at}.${key} must be a model identifier or null`, entry: at });
          }
        }
        const nextKindForModel = op.targetKind ?? current.targetKind;
        // 审计官与 persona 同权声明模型（2026-11-10）：编排草案这条闸漏了它，
        // 于是「用架构师把某岗改成审计官并给它独立模型」这条正常路径会被拦。
        if (!isPersonaBackedTargetKind(nextKindForModel)) {
          const declaredModel = op.model ?? (op.model === undefined ? current.model : null);
          const declaredFallback = op.fallbackModel ?? (op.fallbackModel === undefined ? current.fallbackModel : null);
          if (declaredModel != null || declaredFallback != null) {
            errors.push({ error: `${at}: only persona posts declare a model — ${nextKindForModel} posts run none (tool) or own it elsewhere (a2a/cluster)`, entry: at });
          }
        }
        if (op.fallbackModel && !op.model && !current.model) {
          errors.push({ error: `${at}: fallbackModel requires a primary model (declared here or already on the post)`, entry: at });
        }
      }
      if ((op.op === "pause" || op.op === "resume") && !current.cadence && !op.cadence) {
        errors.push({ error: `${at}: post '${current.title}' has no cadence to ${op.op}`, entry: at });
      }
    }
    seenRefs.add(op.ref ?? `${at}-add`);

    // cadence shape (add: declared; update/pause/resume: optional replacement)
    const cadence = op.cadence !== undefined ? op.cadence : op.op === "add" ? null : undefined;
    if (cadence === null || cadence === undefined) {
      diff.push(diffEntry(op, null, []));
      continue;
    }
    if (typeof cadence !== "object" || Array.isArray(cadence)) {
      errors.push({ error: `${at}.cadence must be an object or null`, entry: at });
      continue;
    }
    const { cron: expr, tz, promptTemplate } = cadence;
    if (!expr || typeof expr !== "string") {
      errors.push({ error: `${at}.cadence.cron is required`, entry: at });
      continue;
    }
    const invalid = cron.validateCron(expr, tz || null);
    if (invalid) {
      errors.push({ error: `${at}.cadence: ${invalid}`, entry: at });
      continue;
    }
    if (tz != null && typeof tz !== "string") {
      errors.push({ error: `${at}.cadence.tz must be an IANA timezone string or null`, entry: at });
      continue;
    }
    if (!promptTemplate || typeof promptTemplate !== "string") {
      errors.push({ error: `${at}.cadence.promptTemplate is required when a cadence is set`, entry: at });
      continue;
    }
    const opWarnings = [];
    const period = cronPeriodMs(expr, tz || null);
    if (period != null && period < minPeriodWarnMinutes() * 60_000) {
      opWarnings.push(`fires every ${Math.round(period / 60_000)}min — denser than the ${minPeriodWarnMinutes()}min advisory floor; watch the cost`);
    }
    const toolErr = toolArgsError(op.op === "add" ? op.targetKind : undefined, cadence);
    if (toolErr) errors.push({ error: `${at}: ${toolErr}`, entry: at });
    diff.push(diffEntry(op, { cron: expr, tz: tz || null, promptTemplate }, opWarnings));
  }

  // tree: apply ops virtually, then walk parent chains.
  const finalMembers = virtualApply(existing, members, errors);
  if (finalMembers) {
    const known = new Set(finalMembers.map((m) => m.id));
    const childCount = new Map();
    for (const m of finalMembers) {
      if (m.parentId) {
        if (!known.has(m.parentId)) {
          errors.push({ error: `post '${m.title}' references parent '${m.parentId}' which is not in the fleet after this draft` });
        } else {
          childCount.set(m.parentId, (childCount.get(m.parentId) ?? 0) + 1);
        }
      }
    }
    for (const [parent, n] of childCount) {
      if (n > SPAN_WARN) {
        warnings.push(`post '${byRefTitle(finalMembers, parent)}' would have ${n} direct reports — over the span-${SPAN_WARN} advisory; prefer a department layer`);
      }
    }
    for (const m of finalMembers) {
      const seen = new Set([m.id]);
      let p = m.parentId ? finalMembers.find((x) => x.id === m.parentId) : null;
      while (p) {
        if (seen.has(p.id)) {
          errors.push({ error: `organization tree would cycle through post '${p.title}'` });
          break;
        }
        seen.add(p.id);
        p = p.parentId ? finalMembers.find((x) => x.id === p.parentId) : null;
      }
    }
  }

  // Orchestration section (add-fleet-architect-edges D1): validate over the
  // VIRTUAL FINAL member set — posts added in this same draft are reference-
  // able by edges. The graph rules live in fleet-orchestration (the same
  // function the REST write face uses); this only feeds it the final state.
  const orch = draft.fleet?.orchestration ?? null;
  let orchView = null;
  if (orch != null) {
    const finalForGraph = finalMembers ?? existing;
    const check = validateOrchestration({ members: finalForGraph, orchestration: orch });
    for (const e of check.errors) errors.push({ error: `orchestration: ${e.error}` });
    warnings.push(...check.warnings);
    // Read view for the diff: mode + constraints + edges, supervisor's
    // implicit grant called out (never stored expanded).
    orchView = {
      mode: orch.mode ?? null,
      constraints: orch.constraints ?? null,
      edges: orch.edges ?? [],
      implicitDispatch: orch.mode === "supervisor" ? "supervisor mode: every post may dispatch to every other post (implicit, not stored)" : null,
    };
  }

  const estimate = estimateFleetCost(draft, { existing, newPostCount });
  return { ok: errors.length === 0, errors, warnings, diff, orchestration: orchView, estimate };
}

function byRefTitle(members, id) {
  return members.find((m) => m.id === id)?.title ?? id;
}

// draft-<n> → minted id: through a ref (parent/edge endpoint), pass-through
// for real ids and null.
function remapRef(ref, idMap) {
  if (typeof ref !== "string") return ref ?? null;
  return idMap.get(ref) ?? ref;
}

// Swap every draft-<n> reference in an orchestration section for the minted
// member ids (edge endpoints only — args are opaque to this layer).
function remapOrchestration(orchestration, idMap) {
  if (!orchestration?.edges?.length || idMap.size === 0) return orchestration;
  return {
    ...orchestration,
    edges: orchestration.edges.map((e) => ({
      ...e,
      ...(e.from !== undefined ? { from: remapRef(e.from, idMap) } : {}),
      ...(e.to !== undefined ? { to: remapRef(e.to, idMap) } : {}),
    })),
  };
}

function diffEntry(op, cadence, opWarnings) {
  const changes = {};
  for (const key of ["title", "parentId", "targetKind", "targetId", "model", "fallbackModel"]) {
    if (op[key] !== undefined) changes[key] = op[key];
  }
  if (cadence !== null) {
    changes.cadence = cadence ? `${cadence.cron}${cadence.tz ? ` (${cadence.tz})` : ""}` : "passive (removed)";
  }
  return { op: op.op, ref: op.ref ?? null, title: op.title ?? null, changes, warnings: opWarnings };
}

// Apply the draft's member ops onto the existing list WITHOUT touching the
// db — the shape the tree checks reason over. Returns null when an op was
// structurally unusable (already reported as an error above). Add ops get
// DETERMINISTIC ids `draft-<n>` (n = add order, 1-based): edges and parentIds
// may reference them, and apply swaps them for the minted ids with the same
// counting — one bridge, one place (add-fleet-architect-edges D1).
function virtualApply(existing, ops, _errors) {
  const members = existing.map((m) => ({ ...m }));
  let addSeq = 0;
  for (const op of ops ?? []) {
    if (!op || typeof op !== "object" || !OPS.includes(op.op)) continue;
    if (op.op === "add") {
      addSeq += 1;
      members.push({
        id: `draft-${addSeq}`,
        title: op.title ?? "(untitled)",
        parentId: op.parentId ?? null,
        targetKind: op.targetKind,
        targetId: op.targetId,
        cadence: op.cadence ?? null,
      });
      continue;
    }
    const idx = members.findIndex((m) => m.id === op.ref);
    if (idx === -1) continue; // unknown ref — already an error above
    if (op.op === "remove") {
      members.splice(idx, 1);
      continue;
    }
    const m = members[idx];
    if (op.title !== undefined) m.title = op.title;
    if (op.parentId !== undefined) m.parentId = op.parentId;
    if (op.targetKind !== undefined) m.targetKind = op.targetKind;
    if (op.targetId !== undefined) m.targetId = op.targetId;
    if (op.cadence !== undefined) m.cadence = op.cadence;
    if (op.op === "pause" && m.cadence) m.cadence = { ...m.cadence, enabled: false };
    if (op.op === "resume" && m.cadence) m.cadence = { ...m.cadence, enabled: true };
  }
  return members;
}

// ── cost estimate (token-denominated range; no money — no price oracle) ─────

// Trigger (grill Q6): >5 new posts OR any new cron rhythm. Returns null when
// untriggered — the spec says the estimate MUST ride big drafts, and may ride
// small ones.
export function estimateFleetCost(draft, { existing = [], newPostCount = null } = {}) {
  const byRef = new Map(existing.map((m) => [m.id, m]));
  const newCronPosts = [];
  for (const op of draft?.members ?? []) {
    if (!op || typeof op !== "object") continue;
    let cron = null;
    let tz = null;
    if (op.op === "add" && op.cadence?.cron) {
      cron = op.cadence.cron;
      tz = op.cadence.tz ?? null;
    } else if (op.op === "update" && op.cadence?.cron) {
      const cur = byRef.get(op.ref);
      cron = op.cadence.cron;
      tz = op.cadence.tz ?? null;
      if (cur?.cadence?.cron === cron && cur?.cadence?.tz === (tz ?? null)) continue; // unchanged rhythm
    }
    if (!cron) continue;
    const period = cronPeriodMs(cron, tz);
    if (period == null) continue;
    newCronPosts.push({
      ref: op.ref ?? null,
      title: op.title ?? byRef.get(op.ref)?.title ?? null,
      cron,
      periodMinutes: Math.round(period / 60_000),
      turnsPerDay: Math.ceil((24 * 60) / Math.max(1, period / 60_000)),
      // Tool posts (add-tool-posts): deterministic calls — turns count, tokens
      // don't. The estimate splits so a fleet's LLM bill reads honest.
      toolPost: op.targetKind === "tool" || byRef.get(op.ref)?.targetKind === "tool",
    });
  }
  const posts = newPostCount ?? (draft?.mode === "create" ? (draft?.members ?? []).length : 0);
  if (posts <= 5 && newCronPosts.length === 0) return null;
  const turnsPerDayTotal = newCronPosts.reduce((s, p) => s + p.turnsPerDay, 0);
  const llmTurnsPerDay = newCronPosts.filter((p) => !p.toolPost).reduce((s, p) => s + p.turnsPerDay, 0);
  const [lo, hi] = tokenRange();
  const monthly = llmTurnsPerDay * 30;
  return {
    trigger: posts > 5 ? "large-add" : "new-cron",
    posts: newCronPosts,
    turnsPerDayTotal,
    llmTurnsPerDay,
    toolTurnsPerDay: turnsPerDayTotal - llmTurnsPerDay,
    tokensPerMonth: [monthly * lo, monthly * hi],
    assumptions: { tokenRange: [lo, hi], daysPerMonth: 30, toolPostsAreFree: true },
  };
}

// ── apply orchestration (revalidate → write via fleet services → reconcile) ─

export async function applyFleetDraft(db, draft, { ownerEmail, resolver = resolveFleetTarget, cronApi = cron, roster = rosterPresetId } = {}) {
  const check = validateFleetDraft(db, draft, { resolver });
  if (!check.ok) {
    return { ok: false, stage: "revalidation", errors: check.errors };
  }
  const now = Date.now();
  const fleetId = draft.mode === "create" ? `fleet_${now}_${Math.random().toString(36).slice(2, 8)}` : draft.fleetId;
  // Same reading as validateFleetDraft: an absent member list means "no member
  // ops", which is how the cockpit's design mode edits orchestration only.
  const memberOps = Array.isArray(draft.members) ? draft.members : [];

  try {
    if (draft.mode === "create") {
      // Born all-paused with a 待启动 banner — the from-template convention:
      // the owner confirms structure before anything fires.
      db.createFleet({ id: fleetId, name: draft.fleet.name, ownerEmail, state: "paused", defaultModel: draft.fleet.defaultModel ?? null });
      let sortKey = now;
      let addSeq = 0;
      const idMap = new Map(); // draft-<n> → minted id (same counting as virtualApply)
      for (const op of memberOps) {
        const minted = `m_${now}_${Math.random().toString(36).slice(2, 8)}`;
        if (op.op === "add") {
          addSeq += 1;
          idMap.set(`draft-${addSeq}`, minted);
        }
        db.createMember({
          id: minted,
          fleetId,
          title: op.title,
          parentId: remapRef(op.parentId ?? null, idMap),
          targetKind: op.targetKind,
          targetId: op.targetId,
          kpiSlots: [],
          cadence: op.cadence ? { ...op.cadence, enabled: false } : null,
          model: op.model ?? null,
          fallbackModel: op.fallbackModel ?? null,
          sortKey: sortKey++,
        });
      }
      if (draft.fleet?.orchestration != null) {
        db.updateFleet(fleetId, { orchestration: remapOrchestration(draft.fleet.orchestration, idMap) },
          { actor: ownerEmail ?? null, via: "fleet-architect:applyFleetDraft:create" });
      }
      const reconcile = await reconcileFleet({ fleetId, db, cronApi, resolveTarget: resolver, rosterPresetId: roster });
      return { ok: true, mode: "create", fleet: db.getFleet(fleetId), members: db.listMembers(fleetId), reconcile, started: false };
    }

    // edit: sequential ops, stop on first failure (already-written ops stand;
    // reconcile is idempotent and converges on the next pass).
    const applied = [];
    let editAddSeq = 0;
    const idMap = new Map(); // draft-<n> → minted id (same counting as virtualApply)
    for (const op of memberOps) {
      if (op.op === "add") {
        editAddSeq += 1;
        const minted = `m_${now}_${Math.random().toString(36).slice(2, 8)}`;
        idMap.set(`draft-${editAddSeq}`, minted);
        const m = db.createMember({
          id: minted,
          fleetId,
          title: op.title,
          parentId: remapRef(op.parentId ?? null, idMap),
          targetKind: op.targetKind,
          targetId: op.targetId,
          kpiSlots: [],
          cadence: op.cadence ?? null,
          model: op.model ?? null,
          fallbackModel: op.fallbackModel ?? null,
          sortKey: now + applied.length,
        });
        applied.push({ op: "add", memberId: m.id });
        continue;
      }
      const current = db.getMember(op.ref);
      if (!current) {
        return { ok: false, stage: "apply", applied, errors: [{ error: `post '${op.ref}' vanished mid-apply (drifted)` }] };
      }
      if (op.op === "remove") {
        db.deleteMember(op.ref);
        applied.push({ op: "remove", memberId: op.ref });
        continue;
      }
      const updates = {};
      for (const key of ["title", "parentId", "model", "fallbackModel"]) {
        if (op[key] !== undefined) updates[key] = op[key];
      }
      if (op.targetKind !== undefined || op.targetId !== undefined) {
        updates.targetKind = op.targetKind ?? current.targetKind;
        updates.targetId = op.targetId ?? current.targetId;
      }
      if (op.cadence !== undefined) updates.cadence = op.cadence;
      if (op.op === "pause" && current.cadence) updates.cadence = { ...current.cadence, ...(updates.cadence ?? {}), enabled: false };
      if (op.op === "resume" && current.cadence) updates.cadence = { ...current.cadence, ...(updates.cadence ?? {}), enabled: true };
      db.updateMember(op.ref, updates);
      applied.push({ op: op.op, memberId: op.ref });
    }
    if (draft.fleet?.name || draft.fleet?.defaultModel !== undefined) {
      const fleetUpdates = {};
      if (draft.fleet?.name) fleetUpdates.name = draft.fleet.name;
      if (draft.fleet?.defaultModel !== undefined) fleetUpdates.defaultModel = draft.fleet.defaultModel ?? null;
      if (Object.keys(fleetUpdates).length) db.updateFleet(fleetId, fleetUpdates, { actor: ownerEmail ?? null, via: "fleet-architect:applyFleetDraft:edit" });
    }
    // Orchestration rides only when the draft carries it — a section-less
    // draft NEVER clears existing edges implicitly (clearing = explicit empty
    // edges, or post deletion's cascade).
    if (draft.fleet?.orchestration != null) {
      db.updateFleet(fleetId, { orchestration: remapOrchestration(draft.fleet.orchestration, idMap) },
        { actor: ownerEmail ?? null, via: "fleet-architect:applyFleetDraft:edit" });
    }
    const reconcile = await reconcileFleet({ fleetId, db, cronApi, resolveTarget: resolver, rosterPresetId: roster });
    return { ok: true, mode: "edit", fleet: db.getFleet(fleetId), members: db.listMembers(fleetId), reconcile, applied };
  } catch (e) {
    return { ok: false, stage: "apply", errors: [{ error: e?.message || String(e) }] };
  }
}

// ── bridge routes (loopback-only via auth.js; identity = cell owner) ────────

// `mount`/`readOnly`: the runner lane (add-fleet-bridge-endpoint-for-agent-runner
// 2.2) gets a READ-ONLY mount at `/api/runner-fleet/architect` — an agent needs
// to read its own fleet (fleet_list), but the org-writing verbs (draft/apply)
// stay behind the cell-local loopback bridge. Narrowing here rather than in the
// client is the only version the model cannot talk its way past.
export function registerFleetArchitectRoutes(ctx, { mount = "/api/fleet-architect", readOnly = false } = {}) {
  const router = Router();
  const ownerEmail = () => {
    const email = ctx?.cellUserEmail;
    if (!email) throw new Error("no cell owner on this context");
    return email;
  };
  // One catalog snapshot per request. The draft/apply paths resolve one
  // target per member, and resolving against the live catalog re-merges it
  // per member (~30ms each) — a per-request view keeps one merge and puts
  // every post of that request on the same snapshot.
  const requestResolver = () => {
    if (ctx?.fleetTargetResolver) return ctx.fleetTargetResolver;
    const view = catalog.mergedView();
    return (member) => resolveFleetTarget(member, view);
  };
  // Read: the owner's fleet roster (counts + failing, no credentials).
  router.get("/fleets", (_req, res) => {
    try {
      const db = getFleetDatabase();
      const fleets = db.listFleets({ ownerEmail: ownerEmail() }).map((f) => {
        const members = db.listMembers(f.id);
        const failing = members.filter((m) => {
          const last = db.latestTurnFor(m.id);
          return last && last.status !== "ok";
        }).length;
        return {
          id: f.id,
          name: f.name,
          state: f.state,
          memberCount: members.length,
          openDecisions: db.countOpenDecisions(f.id),
          failing,
        };
      });
      res.json({ fleets });
    } catch (err) {
      console.error("[fleet-architect] list error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Read: one fleet's full structural spec.
  router.get("/fleets/:id", (req, res) => {
    try {
      const db = getFleetDatabase();
      const fleet = db.getFleet(req.params.id);
      if (!fleet || fleet.ownerEmail !== ownerEmail()) {
        return res.status(404).json({ error: "Fleet not found" });
      }
      const members = db.listMembers(fleet.id).map((m) => ({
        id: m.id,
        title: m.title,
        parentId: m.parentId,
        targetKind: m.targetKind,
        targetId: m.targetId,
        cadence: m.cadence,
        model: m.model,
        fallbackModel: m.fallbackModel,
      }));
      res.json({
        fleet: {
          id: fleet.id,
          name: fleet.name,
          state: fleet.state,
          defaultModel: fleet.defaultModel,
          decisionPolicy: fleet.decisionPolicy,
          sourceTemplate: fleet.sourceTemplate,
        },
        members,
      });
    } catch (err) {
      console.error("[fleet-architect] spec read error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Read: turn events (same store as O1's read face — no second source).
  router.get("/fleets/:id/turns", (req, res) => {
    try {
      const db = getFleetDatabase();
      const fleet = db.getFleet(req.params.id);
      if (!fleet || fleet.ownerEmail !== ownerEmail()) {
        return res.status(404).json({ error: "Fleet not found" });
      }
      const status = req.query.status ?? null;
      const source = req.query.source ?? null;
      if (status && !["ok", "failed", "interrupted"].includes(status)) {
        return res.status(400).json({ error: "status must be one of ok|failed|interrupted" });
      }
      if (source && !["cron", "manual", "delegation", "event"].includes(source)) {
        return res.status(400).json({ error: "source must be one of cron|manual|delegation" });
      }
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      res.json({ turns: db.listFleetTurnEvents(fleet.id, { status, source, limit }) });
    } catch (err) {
      console.error("[fleet-architect] turns read error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Draft: dry-run — validate + diff + estimate, nothing persisted.
  if (!readOnly) router.post("/draft", (req, res) => {
    try {
      res.json(validateFleetDraft(getFleetDatabase(), req.body, { resolver: requestResolver() }));
    } catch (err) {
      console.error("[fleet-architect] draft error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Apply: revalidate first — drift fails honestly.
  if (!readOnly) router.post("/apply", async (req, res) => {
    try {
      const out = await applyFleetDraft(getFleetDatabase(), req.body, { ownerEmail: ownerEmail(), resolver: requestResolver() });
      if (!out.ok) return res.status(409).json(out);
      res.json(out);
    } catch (err) {
      console.error("[fleet-architect] apply error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  ctx.app.use(mount, router);
}
