// server/line-token-renewal.js — server-side renewal of ID-token line
// credentials (add-line-credential-renewal, design D2/D3).
//
// The refresh grant runs here so unattended turns (cron fleet posts) never
// depend on a browser session. Three callers converge on renewLineCredential:
// the pre-round hook (runCronJobTurn → ctx.renewLineCredentialsForTurn), the
// background sweep (startRenewalSweep), and the 401 safety net
// (line-credentials.renewOn401). All single-flight per (owner, line) — two
// triggers firing together cost exactly one token request.
//
// Logto rotates the refresh token on every use: the new value lands in the
// SAME row update as the new ID token (store() is one upsert; dropping the
// new rotator would break the chain). A rejected grant (revocation, password
// change, tenant policy) flips the row stale for the reconnect UI — never
// clears it. Transient failures (network, config unreadable) leave the row
// untouched; the next trigger retries.
//
// Issuer/client_id are re-read from each line's public auth config (cached,
// MINT_TARGETS) — the same self-healing property the mint flow gets from
// reading it live: a line rotating its SPA client needs no platform change.

import * as lineCredentials from "../line-credentials.js";
import { listRenewableLineCredentials } from "../db.js";

const CONFIG_TIMEOUT_MS = 8000;
const CONFIG_CACHE_TTL_MS = 10 * 60 * 1000;

// Fixed-cadence renewal policy (hardened 2026-10-24 after two live data
// points: the tenant's refresh TTL is ~31-33 MINUTES — a renewal 30m35s after
// mint succeeded, the next one 32m43s after that rotation failed
// invalid_grant; far below Logto's 14-day default, i.e. a tenant
// configuration). The rotator is opaque (no readable exp), so the cadence
// keys off the LAST ROTATION (updated_at), never the ID token's exp: renewing
// every <=20min keeps every refresh POST comfortably inside any TTL >= 25min.
// The exp-based window stays only as the pre-round belt (trigger 1).
export const ROTATION_MAX_AGE_MS = 15 * 60 * 1000; // renew when the last rotation is older
export const RENEW_WINDOW_MS = 30 * 60 * 1000; // belt: renew when exp - now < 30min
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const configCache = new Map(); // line -> { at, cfg: { clientId, issuer } }
const inflight = new Map(); // `${email} ${line}` -> Promise<{ renewed, stale? }>

async function lineConfig(line, targets, fetchImpl, now = Date.now()) {
  const cached = configCache.get(line);
  if (cached && now - cached.at < CONFIG_CACHE_TTL_MS) return cached.cfg;
  const target = (targets || lineCredentials.MINT_TARGETS)[line];
  if (!target?.configUrl) throw new Error("no mint target for this line");
  const r = await fetchImpl(target.configUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`auth config HTTP ${r.status}`);
  const cfg = await r.json();
  if (!cfg?.configured || !cfg?.client_id || !cfg?.issuer) throw new Error("line login is not configured");
  const normalized = { clientId: String(cfg.client_id), issuer: String(cfg.issuer).replace(/\/+$/, "") };
  configCache.set(line, { at: now, cfg: normalized });
  return normalized;
}

async function refreshOnce({ email, line, targets, fetchImpl, onRenewed }) {
  const impl = fetchImpl || fetch;
  const state = lineCredentials.renewalState(email, line);
  if (!state?.refreshToken) return { renewed: false };

  let cfg = null;
  try {
    cfg = await lineConfig(line, targets, impl);
  } catch (e) {
    console.warn(`[line-renewal] ${line} auth config unreadable for ${email || "the machine owner"}: ${e?.message || e}`);
    return { renewed: false };
  }

  try {
    const r = await impl(`${cfg.issuer}/oidc/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: state.refreshToken,
        client_id: cfg.clientId,
      }),
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    });
    if (r.status === 400 || r.status === 401) {
      // Rejected grant: the chain is dead. Stale (not clear) so the reconnect
      // UI owns the row. Log identity + line + reason only — never tokens.
      const doc = await r.json().catch(() => ({}));
      lineCredentials.markStale(email, line);
      console.warn(`[line-renewal] ${line} refresh rejected for ${email || "the machine owner"} (${doc?.error || `HTTP ${r.status}`}) — marked stale`);
      return { renewed: false, stale: true };
    }
    if (!r.ok) throw new Error(`token endpoint HTTP ${r.status}`);
    const doc = await r.json();
    const idToken = doc?.id_token;
    if (typeof idToken !== "string" || !idToken) throw new Error("token endpoint returned no id_token");
    // Rotation: store the new rotator with the new ID token in ONE row update.
    // An absent refresh_token keeps the stored chain (never break a live one).
    lineCredentials.store({
      email,
      line,
      token: idToken,
      refreshToken: typeof doc.refresh_token === "string" && doc.refresh_token ? doc.refresh_token : undefined,
    });
    const status = lineCredentials.status(email, line);
    console.log(`[line-renewal] ${line} renewed for ${email || "the machine owner"} (exp in ${status.expiresAt ? Math.round((status.expiresAt - Date.now()) / 60000) : "?"}min)`);
    if (onRenewed) await onRenewed(email, line);
    return { renewed: true };
  } catch (e) {
    // Transient: the row keeps its current token; the next trigger retries.
    console.warn(`[line-renewal] ${line} refresh failed for ${email || "the machine owner"}: ${e?.message || e}`);
    return { renewed: false };
  }
}

// Single-flight per (owner, line): concurrent triggers share one request and
// one result (design D2 — Logto's rotation is lenient in its grace window,
// but we still never spend a second rotation on the same row needlessly).
export async function renewLineCredential(opts) {
  const key = `${opts.email ?? ""} ${opts.line}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = refreshOnce(opts).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

// Trigger 1 (design D3): renew the owner's ID-token lines due by the FIXED
// CADENCE (last rotation older than rotationMaxAgeMs) or the pre-round belt
// (ID token inside expWindowMs of expiry). Rows without a refresh token
// (legacy/manual paste) keep the browser re-mint UX; stale rows wait for a
// human reconnect.
export async function renewDueCredentials({
  email,
  lines = ["wire-customer", "lex"],
  rotationMaxAgeMs = ROTATION_MAX_AGE_MS,
  expWindowMs = RENEW_WINDOW_MS,
  targets,
  fetchImpl,
  onRenewed,
  now = Date.now(),
}) {
  if (!email) return { renewed: [] };
  const renewed = [];
  for (const line of lines) {
    const state = lineCredentials.renewalState(email, line);
    if (!state?.refreshToken || state.stale) continue;
    const lastRotation = state.updatedAt ? Date.parse(state.updatedAt) : 0;
    const agedOut = now - lastRotation > rotationMaxAgeMs;
    const exp = state.tokenExp ?? null;
    const expiring = exp !== null && exp <= now + expWindowMs;
    if (!agedOut && !expiring) continue;
    const out = await renewLineCredential({ email, line, targets, fetchImpl, onRenewed });
    if (out.renewed) renewed.push(line);
  }
  return { renewed };
}

// Trigger 2 (design D3): the sweep body — DB-selected candidates (mint lines,
// refresh token present, not stale, last rotation older than the cadence)
// through the same single-flight renewal. Exported for tests;
// startRenewalSweep schedules it. A side benefit by design: browser users'
// tokens stay alive too, making the connect card's "auto-renew" promise true
// for everyone.
export async function sweepRenewableCredentials({
  rotationMaxAgeMs = ROTATION_MAX_AGE_MS,
  targets,
  fetchImpl,
  onRenewed,
  now = Date.now(),
}) {
  const rows = listRenewableLineCredentials(now, rotationMaxAgeMs);
  const renewed = [];
  for (const row of rows) {
    const out = await renewLineCredential({ email: row.email, line: row.line, targets, fetchImpl, onRenewed });
    if (out.renewed) renewed.push(`${row.email}:${row.line}`);
  }
  return { scanned: rows.length, renewed };
}

export function startRenewalSweep(opts = {}) {
  const sweep = () =>
    sweepRenewableCredentials(opts).catch((e) => console.warn(`[line-renewal] sweep failed: ${e?.message || e}`));
  sweep(); // first pass at boot — one DB read, catches anything that aged while down
  const timer = setInterval(sweep, opts.intervalMs || SWEEP_INTERVAL_MS);
  timer.unref?.(); // never hold the process open
  return () => clearInterval(timer);
}
