// Business roles (openspec: role-system; ADR-0028). A fixed enumeration of
// user types by business function — the pivot for layout presets and
// onboarding recipes in later capabilities. v1 governs presentation only:
// API authorization stays on the existing admin gate, and business roles
// never carry the admin bit (that flag is orthogonal — see composeAdmin).
//
// Storage is two-layer, mirroring the branding pattern: the hosting gateway
// owns a small assignment store and rides the SAME verified-identity channel
// cells already trust (headers stamped next to x-forwarded-email under the
// gateway secret); a single-process deployment stores assignments in its own
// deployment_config key/value table. Resolution is one chain — gateway
// headers → local stored → env seed → standard fallback.
//
// This module is pure (no I/O, no imports from auth.js): auth.js parses the
// role headers at the same trust boundary it parses identity, so a forged
// roles header without the gateway secret is discarded exactly like a forged
// email.

// The enumeration itself lives in core (it is shared client/server contract:
// layout presets, the role editor and the i18n bundles all key on the slugs);
// imported for this module's own use and re-exported so it stays the
// server-side entry point.
import { BUSINESS_ROLES, DEFAULT_ROLE, isBusinessRole } from "../packages/core/src/lib/roles.ts";
export { BUSINESS_ROLES, DEFAULT_ROLE, isBusinessRole };

// Header names the gateway stamps next to the identity headers. Plain JSON so
// a cell needs no schema: `["primary", ...secondary]` for roles, `"1"` for
// the admin flag. Absence means "no hosted assignment" and resolution falls
// through to the local store.
export const ROLES_HEADER = "x-forwarded-roles";
export const ROLE_ADMIN_HEADER = "x-forwarded-role-admin";

// Parse the role headers into { primary, secondary, admin } or null. Callers
// must have already verified the gateway secret for this request (auth.js
// checks it once for the identity pair; the role headers ride the same
// request and the same secret).
export function parseRoleHeaders(headers) {
  const raw = headers?.[ROLES_HEADER];
  if (typeof raw !== "string" || !raw.trim()) return null;
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || !list.length) return null;
  const [primary, ...secondary] = list;
  if (!isBusinessRole(primary)) return null;
  return {
    primary,
    secondary: secondary.filter(isBusinessRole).filter((s) => s !== primary),
    admin: headers[ROLE_ADMIN_HEADER] === "1",
  };
}

// Admission-group mapping per role (design D4): identity groups stay
// authoritative when present; a role's mapped groups apply only when the
// identity carries none. Deployment-overridable via ROLE_ADMISSION_GROUPS
// (JSON object).
const DEFAULT_ADMISSION_GROUPS = {
  legal: ["legal"],
  economic: ["analysts"],
  financial: ["analysts"],
  stock: ["analysts"],
};

export function roleAdmissionGroups(env = process.env) {
  const raw = (env.ROLE_ADMISSION_GROUPS || "").trim();
  if (!raw) return DEFAULT_ADMISSION_GROUPS;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : DEFAULT_ADMISSION_GROUPS;
  } catch {
    console.warn("[roles] ROLE_ADMISSION_GROUPS is not valid JSON; using built-in mapping");
    return DEFAULT_ADMISSION_GROUPS;
  }
}

// Assignment shape: { primary, secondary[], admin }. Normalization drops
// unknown slugs and dedupes; a missing/invalid primary normalizes to null so
// callers can fall through to the next layer rather than storing garbage.
export function normalizeAssignment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const primary = isBusinessRole(value.primary) ? value.primary : null;
  if (!primary) return null;
  const secondary = Array.isArray(value.secondary)
    ? [...new Set(value.secondary.filter(isBusinessRole))].filter((s) => s !== primary)
    : [];
  return { primary, secondary, admin: value.admin === true };
}

function envDefaultAssignment(env) {
  const primary = env.ROLES_DEFAULT_PRIMARY;
  if (!isBusinessRole(primary)) return null;
  const secondary = String(env.ROLES_DEFAULT_SECONDARY || "")
    .split(",")
    .map((s) => s.trim())
    .filter(isBusinessRole)
    .filter((s) => s !== primary);
  return { primary, secondary, admin: false };
}

function envSeedAssignments(env) {
  const raw = (env.ROLES_SEED_ASSIGNMENTS || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [email, value] of Object.entries(parsed)) {
      const assignment = normalizeAssignment(value);
      if (assignment) out[String(email).trim().toLowerCase()] = assignment;
    }
    return out;
  } catch {
    console.warn("[roles] ROLES_SEED_ASSIGNMENTS is not valid JSON; ignoring");
    return {};
  }
}

// Parse the stored assignments document (one deployment_config key). Returns
// { assignments: {email: assignment}, default: assignment|null } or null.
export function parseStoredAssignments(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const assignments = {};
    if (parsed.assignments && typeof parsed.assignments === "object" && !Array.isArray(parsed.assignments)) {
      for (const [email, value] of Object.entries(parsed.assignments)) {
        const assignment = normalizeAssignment(value);
        if (assignment) assignments[String(email).trim().toLowerCase()] = assignment;
      }
    }
    return { assignments, default: normalizeAssignment(parsed.default) };
  } catch {
    console.warn("[roles] stored assignments are not valid JSON; ignoring");
    return null;
  }
}

// Resolve one user's assignment through the chain: pre-parsed gateway
// assignment (from headers) → local stored (per-user, then stored default) →
// env seed (per-user, then env default) → standard fallback. `db` is the
// cell's db module; a not-ready db simply skips the stored layer.
export function resolveAssignment({ user, gatewayAssignment = null, db = null, env = process.env }) {
  if (gatewayAssignment) return { ...gatewayAssignment, source: "gateway" };

  const email = String(user?.email || "").trim().toLowerCase();
  let stored = null;
  if (db?.isDbReady?.()) {
    stored = parseStoredAssignments(db.getDeploymentConfig("roles.assignments"));
  }
  const perUser = stored?.assignments?.[email];
  if (perUser) return { ...perUser, source: "stored" };
  const seeded = envSeedAssignments(env)[email];
  if (seeded) return { ...seeded, source: "env-seed" };
  if (stored?.default) return { ...stored.default, source: "stored-default" };
  const envDefault = envDefaultAssignment(env);
  if (envDefault) return { ...envDefault, source: "env-default" };
  return { primary: DEFAULT_ROLE, secondary: [], admin: false, source: "fallback" };
}

// Admin composition (design D3): the stored/flag admin OR the existing
// ADMIN_GROUPS membership. Group semantics are preserved verbatim so a
// deployment that never touches the role store behaves exactly as before.
export function composeAdmin({ assignment, user, adminGroups }) {
  if (assignment?.admin === true) return true;
  const groups = Array.isArray(user?.groups) ? user.groups : [];
  return adminGroups.some((g) => groups.includes(g));
}

// Effective admission set (design D4): identity groups authoritative when
// present; otherwise the union of the user's roles' mapped groups. `null`
// identityGroups (auth off / no snapshot) mean "no filtering" — the existing
// contract every visibility filter already implements.
export function effectiveAdmissionGroups({ roles, identityGroups, env = process.env }) {
  if (Array.isArray(identityGroups)) {
    if (identityGroups.length) return identityGroups;
    const mapping = roleAdmissionGroups(env);
    const mapped = new Set();
    for (const slug of [roles?.primary, ...(roles?.secondary ?? [])]) {
      for (const g of mapping[slug] ?? []) mapped.add(g);
    }
    return [...mapped];
  }
  return null;
}

// Admission view of one request/connection user: identity groups are
// authoritative when the identity carries any; otherwise the roles' mapped
// groups stand in. The returned object is the SAME `groups` field every
// existing visibility filter reads, so consumers need no new parameter —
// callers replace `user.groups` with this view right after role resolution.
export function admissionView(user, env = process.env) {
  if (!user) return user;
  const groups = effectiveAdmissionGroups({
    roles: user.roles,
    identityGroups: Array.isArray(user.groups) ? user.groups : null,
    env,
  });
  if (groups === null) return user;
  return { ...user, groups };
}
