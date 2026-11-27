// Intent onboarding (openspec: intent-onboarding). The server half: the
// intent profile (a user's answers), the provisioning plan (recipe × installed
// state), and the two-step provisioning action (answers → profile+roles, then
// provision → packs + default expert).
//
// Design D1/D2: answers write the profile and the roles in one atomic step;
// provisioning is a separate call so the confirmation list the user sees is
// exactly what runs. Both are self-service — the self channel writes business
// roles only and NEVER the admin flag.
//
// Plain JS on purpose (server/*.js is not type-stripped); the type-shaped
// contracts live in the .ts core modules this imports.

import { isRoleReady, recipeFor } from "../packages/core/src/lib/recipes.ts";
import { isBusinessRole } from "../packages/core/src/lib/roles.ts";
import { normalizeAssignment, resolveAssignment, roleAdmissionGroups } from "./roles.js";

export const INTENT_PROFILE_KEY = "onboarding.intent";
// Per-user (the preference table is per-cell and a cell can host several
// identities — same rule layout tweaks follow).
export function intentKeyFor(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return normalized ? `${INTENT_PROFILE_KEY}:${normalized}` : INTENT_PROFILE_KEY;
}

// ── Intent profile ──────────────────────────────────────────────────────────

// `wantsTeam` is an INTENT, not a business role (add-team-building-first-run
// 4.1). "I want to build a team" is a different axis from "which domain am I
// in": roles drive which packs install and which landing a user starts on,
// while this intent only routes the user into the building door. Keeping it out
// of BUSINESS_ROLES is deliberate — that slug set is public contract (layout
// presets, admission groups, headers) and a non-business value in it would
// poison layout resolution.
const EMPTY_PROFILE = { roles: [], note: "", skipped: false, answeredAt: null, wantsTeam: false };

export function readIntent({ db, email = null }) {
  if (!db?.isDbReady?.()) return { ...EMPTY_PROFILE };
  try {
    const raw = db.getPreference(intentKeyFor(email));
    if (!raw) return { ...EMPTY_PROFILE };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY_PROFILE };
    return {
      roles: Array.isArray(parsed.roles) ? parsed.roles.filter(isBusinessRole) : [],
      note: typeof parsed.note === "string" ? parsed.note : "",
      skipped: parsed.skipped === true,
      answeredAt: typeof parsed.answeredAt === "string" ? parsed.answeredAt : null,
      wantsTeam: parsed.wantsTeam === true,
    };
  } catch {
    console.warn("[onboarding] stored intent profile is not valid JSON; ignoring");
    return { ...EMPTY_PROFILE };
  }
}

export function writeIntent({ db, email = null }, profile) {
  db.setPreference(intentKeyFor(email), JSON.stringify(profile));
}

// Compose the profile the questionnaire should render for: a stored answer or
// skip wins; else the deployment preset (env); else empty (ask).
export function effectiveIntent({ db, email = null, env = process.env }) {
  const stored = readIntent({ db, email });
  if (stored.answeredAt || stored.skipped) return { ...stored, source: "stored" };
  const presetRoles = String(env.ONBOARDING_DEFAULT_ROLES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(isRoleReady);
  if (presetRoles.length) {
    return {
      roles: presetRoles,
      note: String(env.ONBOARDING_DEFAULT_NOTE || ""),
      skipped: false,
      answeredAt: null,
      wantsTeam: false,
      source: "env-preset",
    };
  }
  return { ...stored, source: "empty" };
}

/**
 * Do the two stores disagree? (2026-11-16)
 *
 * The questionnaire's answer lives in this cell's intent profile; the user's
 * business role lives in the GATEWAY's assignment document (or, unhosted, this
 * cell's copy of it). Those are two stores, and until this function nothing
 * compared them — so when a gateway write failed the answer sat there saying
 * "answered: legal" while the role stayed `standard`, permanently, with no
 * surface able to see it. Live case: aloadtree@gmail.com answered [stock,
 * legal] on 2026-10-16 and was still `fallback` a month later; the landing
 * feature could not explain why a "legal" user landed on /chat.
 *
 * Returns null when there is nothing to report:
 *   · unanswered (no answer is not a mismatch — it is "not asked yet"),
 *   · skipped (an explicit "don't provision me"),
 *   · or the answer's primary IS the assigned primary.
 *
 * Pure: takes the two values, returns the difference. The route decides what
 * to do with it.
 */
export function roleDrift({ intent, assignment }) {
  if (!intent || intent.skipped) return null;
  const answeredPrimary = Array.isArray(intent.roles) ? intent.roles[0] : null;
  if (!intent.answeredAt || !answeredPrimary) return null;
  const assignedPrimary = assignment?.primary ?? null;
  if (answeredPrimary === assignedPrimary) return null;
  return {
    answeredPrimary,
    assignedPrimary,
    assignmentSource: assignment?.source ?? null,
  };
}

// A user needs the questionnaire when nothing is stored and no deployment
// preset answered for them. An answered "wants a team" sets answeredAt, so it
// is already treated as answered; `wantsTeam` is checked explicitly too, so a
// profile carrying only the intent (no answeredAt, e.g. an older row) still
// never re-prompts.
export function needsQuestionnaire({ db, email = null, env = process.env }) {
  const intent = effectiveIntent({ db, email, env });
  return intent.source === "empty" && !intent.answeredAt && !intent.skipped && !intent.wantsTeam;
}

// ── Provisioning plan ───────────────────────────────────────────────────────

// Build the plan for a role. `installed` = pack ids already installed;
// `marketplaceOff` = no pack marketplace on this deployment (the plan degrades
// to layout + expert, per the spec's degradation requirement); `resolved` maps
// a recipe pack reference (its authored display name) to the id this
// deployment minted for it — { ref: { packId, name } }.
//
// Resolution is injected rather than done here: this stays pure, and the
// lookup needs network/market access the caller owns. A reference that did
// not resolve is reported as `unavailable` and marks the plan degraded —
// the confirmation list shows the rest and the closing note (spec: "unavailable
// pack omitted without blocking").
//
// Admission is deliberately NOT pre-judged here: pack visibility is
// private/public (there is no per-pack group gate to evaluate), while the
// group-gated resources a pack references resolve at install time. The plan
// therefore lists every recipe pack not already installed, and provisioning
// reports each item's outcome — a failing item never blocks the rest (D5).
export function buildPlan({ role, installed = [], marketplaceOff = false, resolved = {} }) {
  const recipe = recipeFor(role);
  if (!recipe) return null;
  const installedSet = new Set(installed);
  const packs = marketplaceOff
    ? []
    : recipe.packs.map((ref) => {
        const hit = resolved[ref];
        if (!hit?.packId) return { ref, packId: null, name: ref, status: "unavailable" };
        return {
          ref,
          packId: hit.packId,
          name: hit.name || ref,
          status: installedSet.has(hit.packId) ? "installed" : "install",
        };
      });
  return {
    role,
    defaultExpert: recipe.defaultExpert,
    prompts: recipe.prompts,
    layoutPreset: recipe.layoutPreset,
    packs,
    degraded: marketplaceOff || packs.some((p) => p.status === "unavailable"),
  };
}

// Roles' mapped admission groups, exported for callers that need the
// provisioning user's effective admission view.
export { roleAdmissionGroups };

// ── Answers ─────────────────────────────────────────────────────────────────

// Validate an answers payload: 1..3 roles, all ready, note bounded. Returns
// { ok, value } or { error } — the route maps errors to 4xx.
//
// The `wantsTeam` path is its own branch (add-team-building-first-run 4.2): it
// records the build intent and NO roles. It is not a skip (the user did answer)
// and it never touches the role assignment, so a user who later picks a domain
// still lands on that domain's layout.
export function validateAnswers(body) {
  const roles = Array.isArray(body?.roles) ? body.roles : [];
  if (body?.skipped === true) {
    return { ok: true, value: { roles: [], note: "", skipped: true, wantsTeam: false } };
  }
  if (body?.wantsTeam === true) {
    // Roles are IGNORED on this path, not merged: the door routes the user into
    // a building conversation, and a half-role would install packs they did not
    // ask for. A note is still collected (it seeds the first prompt).
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
    return { ok: true, value: { roles: [], note, skipped: false, wantsTeam: true } };
  }
  if (!roles.length) return { error: "select at least one role" };
  if (roles.length > 3) return { error: "select at most three roles" };
  const unknown = roles.filter((r) => !isBusinessRole(r));
  if (unknown.length) return { error: `unknown roles: ${unknown.join(", ")}` };
  const notReady = roles.filter((r) => !isRoleReady(r));
  if (notReady.length) return { error: `roles without a recipe: ${notReady.join(", ")}` };
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
  return { ok: true, value: { roles: [...new Set(roles)], note, skipped: false, wantsTeam: false } };
}

// ── Role writes (self channel) ──────────────────────────────────────────────

// The self-service assignment: primary = first selected role, secondary = the
// rest. NEVER touches the admin flag (a self-service answer must not be a
// privilege escalation — design D2) — the existing flag is preserved verbatim.
export function selfAssignment(roles, current) {
  const [primary, ...secondary] = roles;
  const base = normalizeAssignment({ primary, secondary }) ?? { primary: "standard", secondary: [], admin: false };
  return { ...base, admin: current?.admin === true };
}

// The resolved assignment for one user in this cell (plan-building helper).
export function currentAssignment({ db, email, env = process.env }) {
  return resolveAssignment({ user: { email }, db, env });
}

// ── Self-service write, hosted aware ────────────────────────────────────────

// In a hosted deployment the assignments live in the GATEWAY's store: the
// gateway stamps x-forwarded-roles from that document on every request and
// resolveAssignment prefers it, so a cell-local write alone never reaches the
// browser (the 2026-10-17 defect: a user picked a domain, every page kept the
// default navigation). Design D1 always called for "托管走 gateway 指派存储的
// 内部写入" — this is that write.
//
// Returns { ok } or { error }. On a hosted cell the gateway write is
// load-bearing: if it fails the caller must NOT report success, because the
// stored answer would be silently dead.
export async function writeSelfAssignment({ email, roles, env = process.env, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (String(env.CLOUD_MODE || "") !== "1" && String(env.CLOUD_MODE || "").toLowerCase() !== "true") {
    return { ok: true, hosted: false };
  }
  const secret = String(env.CELL_GATEWAY_SECRET || "");
  if (!secret) return { error: "hosted cell without CELL_GATEWAY_SECRET" };
  // Identity is NOT sent (harden-cell-isolation 1.3): the gateway derives the
  // target from this cell's credential. `email` stays in the signature because
  // non-hosted callers still use it, but it never rides the wire — except under
  // the grey switch, where an older gateway still reads it from the body.
  const legacy = String(env.CELL_CREDENTIAL_LEGACY || "") === "1";
  if (!legacy && !env.CELL_ID) {
    return { error: "hosted cell without CELL_ID — cannot name itself to the gateway" };
  }
  const base = (env.GATEWAY_INTERNAL_URL || `http://127.0.0.1:${env.GATEWAY_PORT || 3080}`).replace(/\/+$/, "");
  let res;
  try {
    res = await fetchImpl(`${base}/api/roles/self`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloud-gateway-secret": secret },
      body: JSON.stringify(legacy ? { email, roles } : { roles }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { error: `role assignment channel unreachable: ${e?.message || e}` };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { error: body?.error || `role assignment failed (HTTP ${res.status})` };
  }
  return { ok: true, hosted: true };
}
