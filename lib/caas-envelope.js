// ── CaaS delivery envelope (openspec: add-caas-delivery-contract) ───────────
//
// The ONE authority for "what forms can be delivered" and "which form reaches
// this recipient". Every surface (chat persona, zhiyu room, A2A, VAAS publish)
// derives its form vocabulary from ./caas-forms.json — a byte-identical copy of
// openspec/changes/add-caas-delivery-contract/caas-forms.json, checked by
// check_caas_conformance. Hard-coding a form list anywhere else is a violation.
//
// Pure functions, zero dependencies: it must be loadable from a cell, a
// gateway, a test, or a one-off script without pulling anything in.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORMS_PATH = path.join(HERE, "caas-forms.json");

/** Parsed authority. Read once at import; the file is versioned, not hot-reloaded. */
export const CAAS = JSON.parse(readFileSync(FORMS_PATH, "utf8"));

export const VERSION = CAAS.version;
export const FORMS = Object.freeze(Object.keys(CAAS.forms));
export const ACK_ORDER = Object.freeze([...CAAS.ack.order]);
export const ACK_ALIASES = Object.freeze({ ...CAAS.ack.aliases });
export const RECIPIENTS = Object.freeze({ ...CAAS.recipients });

const ACK_RANK = new Map(ACK_ORDER.map((a, i) => [a, i]));

/** Normalise an ack word: aliases collapse onto their canonical value. */
export function canonicalAck(word) {
  const w = String(word ?? "").trim().toLowerCase();
  if (ACK_RANK.has(w)) return w;
  const alias = ACK_ALIASES[w];
  return alias && ACK_RANK.has(alias) ? alias : null;
}

/** Rank of an ack word (higher = stronger). Unknown returns -1. */
export function ackRank(word) {
  const c = canonicalAck(word);
  return c === null ? -1 : ACK_RANK.get(c);
}

/**
 * Which form actually reaches this recipient?
 *
 * Walks the envelope's forms in the caller's stated order and returns the first
 * one the recipient can read. That ordering is deliberate: the sender ranks its
 * own preferences, the recipient only vetoes. Returns null when nothing
 * intersects — the caller MUST then fail the delivery and name both sets, never
 * silently fall back to a form the recipient never declared.
 */
export function resolveForm(forms, recipientCaps) {
  const caps = new Set(recipientCaps ?? []);
  for (const f of forms ?? []) {
    if (caps.has(f)) return f;
  }
  return null;
}

/** Capability list for a recipient kind; unknown kind → [] (caller must reject). */
export function capsFor(recipientKind) {
  const r = RECIPIENTS[recipientKind];
  return r ? [...r.caps] : [];
}

/** Strongest ack this recipient kind can ever prove. Unknown → null. */
export function maxAckFor(recipientKind) {
  const r = RECIPIENTS[recipientKind];
  return r ? r.max_ack : null;
}

/**
 * Validate an envelope's shape. Returns {ok:true, env} or
 * {ok:false, missing:[...], reason}. Never throws for a bad envelope: the
 * caller decides how to surface it, and the spec demands the missing field be
 * named rather than the delivery being downgraded into a broadcast.
 */
export function validateEnvelope(env) {
  const missing = [];
  if (!env || typeof env !== "object") return { ok: false, missing: ["<envelope>"], reason: "not an object" };

  const to = env.to;
  const hasTo = typeof to === "string" ? to.trim().length > 0 : Boolean(to && typeof to === "object" && (to.seatId || to.slug || to.email || to.url));
  if (!hasTo) missing.push("to");

  const forms = Array.isArray(env.forms) ? env.forms : null;
  if (!forms || forms.length === 0) missing.push("forms");
  else {
    const unknown = forms.filter((f) => !FORMS.includes(f));
    if (unknown.length) return { ok: false, missing: [], reason: `unknown form(s): ${unknown.join(", ")}` };
  }

  if (!canonicalAck(env.ack)) missing.push("ack");

  const corr = env.correlation;
  if (!corr || typeof corr !== "object" || !String(corr.idem ?? "").trim()) missing.push("correlation.idem");

  return missing.length ? { ok: false, missing, reason: "missing required field(s)" } : { ok: true, env };
}

/**
 * Project a delivery outcome onto exactly one of three values.
 *
 *   delivered — reached the channel
 *   consumed  — recipient read/consumed it
 *   failed    — did not arrive (reason + retryable)
 *
 * `downgraded` is true when the declared ack strength exceeds what was actually
 * proven. That flag is load-bearing: a caller who asked for `consumed` and got
 * `delivered` must be able to see it, otherwise the absence of an error reads
 * as a satisfied contract.
 */
export function ackProjection({ ackDeclared, ackActual, failed = false, retryable = false, reason = "" } = {}) {
  if (failed) {
    return { state: "failed", retryable: Boolean(retryable), reason: String(reason || "delivery failed"), downgraded: false };
  }
  const actual = canonicalAck(ackActual);
  const declared = canonicalAck(ackDeclared);
  if (!actual) {
    return { state: "failed", retryable: false, reason: `unknown ack actual: ${ackActual}`, downgraded: false };
  }
  const downgraded = declared !== null && ackRank(actual) < ackRank(declared);
  return { state: actual, retryable: false, reason: "", downgraded };
}

/** A stable, content-derived idempotency key for a delivery attempt. */
export function idemKeyFor({ to, form, body }) {
  const raw = `${typeof to === "string" ? to : JSON.stringify(to)}|${form}|${JSON.stringify(body ?? null)}`;
  return fnv1a(raw);
}

/** FNV-1a 64-bit via BigInt — no crypto import, good enough for idempotency keys. */
function fnv1a(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < str.length; i += 1) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
