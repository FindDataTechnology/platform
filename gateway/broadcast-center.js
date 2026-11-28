// ── Broadcast center (add-broadcast-and-notification-inbox 1.5 / 2.1) ───────
//
// The gateway's half of broadcast: resolve an audience, record the broadcast,
// hand nodes a pull endpoint, and take their delivery receipts. It runs HERE
// rather than in a cell because a broadcast is a deployment-wide action — a
// cell that issued one would be addressing users it has no way to resolve,
// and a cell-local ledger would be invisible to every other cell.
//
// Identity authority is Logto (lib/logto-identity-source.js). The deployment's
// OIDC app credentials do NOT work for the Management API (measured: 400
// invalid_client), so a dedicated M2M app holds the "Logto Management API
// access" role and its client id/secret come from their own env vars; unset
// means the surface answers "not configured" rather than silently degrading.
//
// Business roles are NOT Logto roles (measured: Logto returns zero for them).
// They live in this gateway's role store, so role audience is answered locally
// through a plain lookup function — no database, no bridging.
//
// Receipts, not assumptions: the pull model means only a node knows whether a
// recipient got their row. hit/ok/fail therefore start 0/0/hit and grow from
// reports (design D3).

import path from "node:path";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { AudienceError, describeAudience, resolveAudience } from "../lib/broadcast-audience.js";
import { BROADCAST_LEDGER_DDL, createBroadcastLedger } from "../lib/broadcast-store.js";
import { createCompositeIdentitySource, createLogtoIdentitySource } from "../lib/logto-identity-source.js";

const MAX_TITLE = 200;
const MAX_BODY = 4000; // the bot-relay ceiling (bots.MAX_RELAY_CHARS) — one limit, not two
const MAX_IDS = 500;

/**
 * Build the center from env. Returns null when the ledger cannot be opened —
 * broadcast is an optional capability and its absence must not stop a gateway.
 *
 * @param {object} deps
 * @param {string} deps.dataRoot
 * @param {{list: () => Array<{email: string, primary: string}>}} deps.roleStore
 */
export function openBroadcastCenter({ dataRoot, roleStore, env = process.env } = {}) {
  let db;
  try {
    mkdirSync(dataRoot, { recursive: true });
    db = new Database(path.join(dataRoot, "broadcasts.db"));
    db.exec(BROADCAST_LEDGER_DDL);
  } catch (err) {
    console.error("[broadcast] ledger unavailable:", err?.message || err);
    try {
      db?.close();
    } catch {
      /* already unusable */
    }
    return null;
  }
  const logto = createLogtoIdentitySource({
    endpoint: env.LOGTO_ENDPOINT,
    clientId: env.LOGTO_M2M_CLIENT_ID,
    clientSecret: env.LOGTO_M2M_CLIENT_SECRET,
  });

  const emailsWithPrimaryRole = (roleSlug) => {
    const wanted = String(roleSlug ?? "").trim().toLowerCase();
    if (!wanted) return [];
    return (roleStore?.list?.() ?? [])
      .filter((row) => String(row?.primary ?? "").toLowerCase() === wanted && row?.email)
      .map((row) => String(row.email).trim().toLowerCase());
  };

  const identitySource = createCompositeIdentitySource({ logto, emailsWithPrimaryRole });
  const ledger = createBroadcastLedger({ db });

  return {
    db,
    logto,
    ledger,
    identitySource,
    // The route speaks to the center, not to its parts — one object to fake in
    // a route test.
    resolveAudience: (selector) => resolveAudience(selector, identitySource),
    describeAudience,
    pendingSince: (since, limit) => ledger.pendingSince(since, limit),
  };
}

/** Validate the request payload. Returns { error } or the normalized fields. */
export function parseBroadcastBody(body, maxBody = MAX_BODY) {
  const audience = body?.audience;
  if (!audience || typeof audience !== "object") return { error: "audience is required" };
  const title = String(body?.title ?? "").trim().slice(0, MAX_TITLE);
  const message = String(body?.body ?? "");
  if (!message.trim()) return { error: "body is required" };
  if (message.length > maxBody) return { error: `body must be at most ${maxBody} characters` };
  if (audience.kind === "userIds") {
    const ids = Array.isArray(audience.ids) ? audience.ids : [];
    if (ids.length > MAX_IDS) return { error: `at most ${MAX_IDS} explicit recipients` };
  }
  const wake = ["none", "batch", "immediate"].includes(body?.wake) ? body.wake : "none";
  // Optional action carried by the notice (design D5). Shape is
  // `{actionId, args}` — a REGISTERED action id, because the platform has
  // exactly one permission-checked way to invoke a tool. A free-form tool name
  // would either bypass that gate or fail for every notice, so it is refused
  // here rather than accepted and rejected later.
  let action = null;
  if (body?.action != null) {
    const actionId = String(body.action?.actionId ?? "").trim();
    if (!actionId) return { error: "action.actionId is required when action is present" };
    action = { actionId, args: body.action?.args && typeof body.action.args === "object" ? body.action.args : {} };
  }
  return { audience, title, body: message, wake, action };
}

export function broadcastErrorStatus(code) {
  switch (code) {
    case "unknown-kind":
    case "bad-selector":
    case "zero-hits":
      return 400;
    case "identity-source-unavailable":
      return 503;
    default:
      return 500;
  }
}

export { AudienceError, describeAudience, resolveAudience };
