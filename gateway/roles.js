// Gateway-side role store (openspec: role-system, design D2). The hosting
// gateway is the deployment's administrative plane: it owns the assignment
// document (assignments by email, a deployment default, and a roster of known
// user emails), answers /api/roles* itself — before the cell-proxy catch-all
// — and stamps the resolved assignment onto the same signed identity channel
// cells already trust (x-forwarded-roles / x-forwarded-role-admin, verified
// by the cell against CELL_GATEWAY_SECRET).
//
// One file, atomic writes, in-memory read model: single admin operator, JSON
// document, no concurrent writers by construction. Rollback = delete the file
// (everyone falls back to `standard`, byte-identical to a deployment without
// the role system).

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { atomicWriteJsonSync } from "../lib/persistence.js";
import {
  BUSINESS_ROLES,
  DEFAULT_ROLE,
  isBusinessRole,
  normalizeAssignment,
  parseStoredAssignments,
  resolveAssignment,
} from "../server/roles.js";

export function createRoleStore({ file, env = process.env }) {
  let doc = { assignments: {}, default: null, roster: [] };
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    const normalized = parseStoredAssignments(raw);
    if (normalized) doc.assignments = normalized.assignments;
    if (normalized?.default) doc.default = normalized.default;
    if (Array.isArray(parsed?.roster)) {
      doc.roster = parsed.roster.filter((e) => typeof e === "string" && e.includes("@")).map((e) => e.trim().toLowerCase());
    }
  } catch {
    // Missing or unreadable file = empty store, not an error.
  }

  const persist = () => {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      /* dir may exist */
    }
    atomicWriteJsonSync(file, { assignments: doc.assignments, default: doc.default, roster: doc.roster });
  };

  return {
    file,
    // Assignment for one email through the chain: stored per-user → stored
    // default → env seed/default → standard. Shares the cell's resolver, so
    // hosted and local answer identically for the same document.
    assignmentFor(email) {
      const normalized = String(email || "").trim().toLowerCase();
      return resolveAssignment({
        user: { email: normalized },
        db: {
          isDbReady: () => true,
          getDeploymentConfig: () => JSON.stringify({ assignments: doc.assignments, default: doc.default }),
        },
        env,
      });
    },
    // Remember a user we have routed traffic for, so the admin surface lists
    // real people (cells are keyed by hash; the email exists only in memory).
    noteUser(email) {
      const normalized = String(email || "").trim().toLowerCase();
      if (!normalized || !normalized.includes("@")) return false;
      if (doc.roster.includes(normalized)) return false;
      doc.roster.push(normalized);
      persist();
      return true;
    },
    // Admin listing: roster ∪ assignment keys, each with its resolved
    // assignment (so unassigned users show their effective default).
    list() {
      const emails = [...new Set([...doc.roster, ...Object.keys(doc.assignments)])].sort();
      return emails.map((email) => ({ email, ...this.assignmentFor(email) }));
    },
    get(email) {
      const normalized = String(email || "").trim().toLowerCase();
      return this.assignmentFor(normalized);
    },
    // Whole-assignment replace for one user. Validates the payload; returns
    // { ok } or { error } — the route maps errors to 4xx.
    set(email, value) {
      const normalized = String(email || "").trim().toLowerCase();
      if (!normalized || !normalized.includes("@")) return { error: "invalid user id" };
      if (value?.primary !== undefined && !isBusinessRole(value.primary)) {
        return { error: `unknown role '${value.primary}'` };
      }
      const assignment = normalizeAssignment({
        primary: value?.primary ?? DEFAULT_ROLE,
        secondary: value?.secondary ?? [],
        admin: value?.admin === true,
      });
      if (!assignment) return { error: "invalid assignment" };
      // Clearing to the untouched state (default primary, no secondary, no
      // flag) removes the row rather than storing a redundant one.
      const isNeutral = assignment.primary === DEFAULT_ROLE && !assignment.secondary.length && !assignment.admin;
      if (isNeutral) delete doc.assignments[normalized];
      else doc.assignments[normalized] = assignment;
      if (!doc.roster.includes(normalized)) doc.roster.push(normalized);
      persist();
      return { ok: true, assignment: this.assignmentFor(normalized) };
    },
    // Self-service role write (intent-onboarding). Distinct from `set` in the
    // one way that matters: this channel can NEVER touch the admin flag. It
    // preserves whatever admin state the user already has and writes business
    // roles only — an onboarding answer must never be a privilege escalation
    // (the same hard rule the cell-side self channel enforces).
    //
    // It exists because a hosted deployment's assignments live HERE: the cell
    // stores its own copy, but the gateway stamps `x-forwarded-roles` from this
    // document on every request and resolveAssignment prefers the gateway
    // source, so a cell-side write alone is invisible (the 2026-10-17 defect —
    // a user picked 法律 and every page kept the default navigation).
    setSelf(email, { primary, secondary = [] } = {}) {
      const normalized = String(email || "").trim().toLowerCase();
      if (!normalized || !normalized.includes("@")) return { error: "invalid user id" };
      if (!isBusinessRole(primary)) return { error: `unknown role '${primary}'` };
      const current = this.assignmentFor(normalized);
      const assignment = normalizeAssignment({
        primary,
        secondary,
        admin: current.admin === true,
      });
      if (!assignment) return { error: "invalid assignment" };
      const isNeutral = assignment.primary === DEFAULT_ROLE && !assignment.secondary.length && !assignment.admin;
      if (isNeutral) delete doc.assignments[normalized];
      else doc.assignments[normalized] = assignment;
      if (!doc.roster.includes(normalized)) doc.roster.push(normalized);
      persist();
      return { ok: true, assignment: this.assignmentFor(normalized) };
    },
    // Deployment default (all users without a per-user row). Read-only here:
    // the default is seeded from env (ROLES_DEFAULT_PRIMARY) per the spec's
    // deployment-level seeding requirement, not edited through a live route.
    getDefault() {
      const withDefault = resolveAssignment({
        user: { email: "default@deployment.invalid" },
        db: {
          isDbReady: () => true,
          getDeploymentConfig: () => JSON.stringify({ assignments: {}, default: doc.default }),
        },
        env,
      });
      return { default: doc.default, effective: withDefault };
    },
    // Role headers for one request's identity: resolved assignment as the
    // compact wire shape [primary, ...secondary], admin flag separate.
    headersFor(email) {
      const assignment = this.assignmentFor(email);
      return {
        roles: JSON.stringify([assignment.primary, ...assignment.secondary]),
        admin: assignment.admin ? "1" : "0",
      };
    },
    roles: BUSINESS_ROLES,
  };
}

// Admin mutation gate with the SAME semantics the rest of the gateway uses
// (admin group today; stored admin flag composes in via the store lookup).
export function makeIsAdminUser({ adminGroups, store }) {
  return (user) => {
    if (!user?.email) return false;
    const groups = Array.isArray(user.groups) ? user.groups : [];
    if (adminGroups.some((g) => groups.includes(g))) return true;
    return store.assignmentFor(user.email).admin === true;
  };
}
