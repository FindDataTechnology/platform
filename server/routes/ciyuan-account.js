// routes/ciyuan-account.js — bind a user's 词元 account without pasting a key
// (ciyuan-account-lane, design D2/D8/D9).
//
// connect: the user types their 词元 email + password; the server logs in
// server-to-server, mints a key through 词元's key API, stores ONLY the minted
// key (ciyuan-account-credentials), and lets the password and login token die
// with this request — they are never persisted, logged, or echoed. Then the
// cell's dsh credential store is rewritten so the next model request bills the
// user's own account (hosted cells only; see dsh-profile ensureCredentialsStore).
// test: probes 词元 with the stored key (200 heals / 401 flips stale).
// disconnect: drops the local key (the 词元-side key stays; the card says so).

import { createHash } from "node:crypto";
import * as ciyuanAccount from "../../ciyuan-account-credentials.js";

const DEFAULT_API_BASE = "https://token.finddatatech.cloud";
const DEFAULT_GROUP_ID = 3; // same group as the deployment key (design D3)
const UPSTREAM_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

function apiBase() {
  return String(process.env.CIYUAN_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function mintGroupId() {
  const n = Number.parseInt(String(process.env.CIYUAN_MINT_GROUP_ID ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GROUP_ID;
}

function identity(req) {
  return req.ssoUser || req.user || null;
}

function requireOwner(req, res, ctx) {
  if (!ctx.authEnabled) return true;
  if (!identity(req)?.email) {
    res.status(401).json({ error: "Authentication is required" });
    return false;
  }
  return true;
}

// Which form this process runs in decides whether a bound key can drive the
// model lane: a hosted cell serves exactly one identity (override allowed), a
// shared single-process store serves many (never override — design D6).
function modelLaneForm(ctx) {
  return ctx.cellUserEmail ? "cell" : "shared";
}

function connectionPayload(ctx, email) {
  return { ...ciyuanAccount.status(email), modelLaneForm: modelLaneForm(ctx) };
}

// Rewrite the cell's dsh credential store so the override (or its removal)
// reaches the next LLM request. Failure here must not undo a stored binding —
// the card still reports the truth and the next store write catches up.
async function rewriteModelLane(ctx) {
  try {
    const dshProfile = await import("../../dsh-profile.js");
    await dshProfile.ensureCredentialsStore({ cellOwnerEmail: ctx.cellUserEmail || null });
  } catch (e) {
    console.warn(`[ciyuan-account] credential store rewrite failed: ${e?.message || e}`);
  }
}

function reapplyMcp(ctx, user) {
  ctx
    .dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, user?.groups ?? null, user?.email ?? null)
    ?.catch((e) => console.warn(`[ciyuan-account] profile update failed: ${e.message}`));
}

// yizuo-<8 hex of the platform identity>-<yyyymmdd>: recognisable in the 词元
// console, carries no email.
export function keyNameFor(email, now = new Date()) {
  const hash = createHash("sha256").update(String(email ?? "owner")).digest("hex").slice(0, 8);
  const d = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `yizuo-${hash}-${d}`;
}

// Pull the plaintext key out of the mint response without assuming one exact
// envelope: the first `sk-` string among the usual field names wins.
export function extractMintedKey(body) {
  const data = body && typeof body === "object" ? (body.data && typeof body.data === "object" ? body.data : body) : null;
  if (!data) return null;
  for (const field of ["key", "api_key", "apiKey", "token", "value"]) {
    const v = data[field];
    if (typeof v === "string" && v.startsWith("sk-")) return { key: v, id: data.id ?? null };
  }
  return null;
}

function extractAccessToken(body) {
  const data = body && typeof body === "object" ? (body.data && typeof body.data === "object" ? body.data : body) : null;
  if (!data) return null;
  for (const field of ["access_token", "accessToken", "token"]) {
    if (typeof data[field] === "string" && data[field]) return data[field];
  }
  return null;
}

// Upstream error text for the user: short, never echoes request material.
function upstreamReason(body, fallback) {
  const msg = body && typeof body === "object" ? body.message || body.error || body.msg : null;
  const text = typeof msg === "string" ? msg : fallback;
  return String(text).replace(/sk-[A-Za-z0-9_-]+/g, "sk-…").slice(0, 160);
}

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  let body = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, ok: r.ok, body };
}

export function registerCiyuanAccountRoutes(ctx) {
  const { app, db } = ctx;

  app.get("/api/ciyuan-account/connection", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "词元 account binding is disabled (database unavailable)" });
    }
    res.json(connectionPayload(ctx, identity(req)?.email ?? null));
  });

  app.post("/api/ciyuan-account/connect", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "词元 account binding is disabled (database unavailable)" });
    }
    const { email: ciyuanEmail, password } = req.body || {};
    if (typeof ciyuanEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ciyuanEmail.trim()) || ciyuanEmail.length > 254) {
      return res.status(400).json({ error: "Enter the email of your 词元 account" });
    }
    if (typeof password !== "string" || !password || password.length > 256) {
      return res.status(400).json({ error: "Enter your 词元 password" });
    }
    const user = identity(req);
    const base = apiBase();

    // 1. login — the only place the password is used; it is not retained.
    let accessToken = null;
    try {
      const login = await fetchJson(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: ciyuanEmail.trim(), password }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!login.ok) {
        if (login.status === 400 || login.status === 401 || login.status === 403) {
          return res.status(401).json({ error: "词元 login failed — check the email and password of your 词元 account" });
        }
        return res.status(502).json({ error: `词元 login service answered ${login.status}: ${upstreamReason(login.body, "unavailable")}` });
      }
      accessToken = extractAccessToken(login.body);
      if (!accessToken) {
        return res.status(502).json({ error: "词元 login answered without a session token" });
      }
    } catch (e) {
      // Network/timeout: state untouched, readable reason, no request material.
      return res.status(502).json({ error: `词元 login service unreachable (${e?.name === "TimeoutError" ? "timed out" : "network error"})` });
    }

    // 2. mint — a fresh key named for this platform identity, in the configured group.
    const groupId = mintGroupId();
    const keyName = keyNameFor(user?.email ?? null);
    let minted = null;
    try {
      const mint = await fetchJson(`${base}/api/v1/keys`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ name: keyName, group_id: groupId }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!mint.ok) {
        return res.status(502).json({ error: `词元 refused to mint a key (${mint.status}): ${upstreamReason(mint.body, "no detail")}` });
      }
      minted = extractMintedKey(mint.body);
      if (!minted) {
        return res.status(502).json({ error: "词元 minted a key but the response carried no sk- value" });
      }
    } catch (e) {
      return res.status(502).json({ error: `词元 key service unreachable (${e?.name === "TimeoutError" ? "timed out" : "network error"})` });
    } finally {
      accessToken = null;
    }

    // 3. store only the minted key, then let the model lane pick it up.
    const status = ciyuanAccount.store({
      email: user?.email ?? null,
      token: minted.key,
      keyId: minted.id,
      keyName,
      groupId,
      ciyuanEmail: ciyuanEmail.trim(),
    });
    if (!status) {
      return res.status(500).json({ error: "Failed to store the credential" });
    }
    console.log(`[ciyuan-account] bound (key ${keyName}, group ${groupId}) — value redacted`);
    await rewriteModelLane(ctx);
    reapplyMcp(ctx, user);
    res.json(connectionPayload(ctx, user?.email ?? null));
  });

  // Probe 词元 with the stored key. 200 heals a stale row; 401/403 flips stale
  // and falls the model lane back to the deployment seed; anything else (network,
  // 5xx) leaves state alone — a flapping upstream must not unbind anyone.
  app.post("/api/ciyuan-account/test", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    const user = identity(req);
    const email = user?.email ?? null;
    const row = ciyuanAccount.status(email);
    if (!row.connected && !row.stale) {
      return res.status(400).json({ error: "No 词元 account is bound yet", ...connectionPayload(ctx, email) });
    }
    // A stale row still has its key; probe with it so a healed upstream heals the row.
    const key = ciyuanAccount.liveToken(email) ?? ciyuanAccount.storedKeyForProbe(email);
    if (!key) {
      return res.status(400).json({ error: "No key available to test", ...connectionPayload(ctx, email) });
    }
    let outcome;
    try {
      const r = await fetch(`${apiBase()}/v1/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (r.ok) {
        if (ciyuanAccount.markHealthy(email)) {
          await rewriteModelLane(ctx);
          reapplyMcp(ctx, user);
        }
        outcome = { reachable: true, detail: "HTTP 200" };
      } else if (r.status === 401 || r.status === 403) {
        if (ciyuanAccount.markStale(email)) {
          await rewriteModelLane(ctx);
          reapplyMcp(ctx, user);
        }
        outcome = { reachable: true, detail: `HTTP ${r.status} — key rejected` };
      } else {
        outcome = { reachable: true, detail: `HTTP ${r.status} — state unchanged` };
      }
    } catch (e) {
      outcome = { reachable: false, detail: e?.name === "TimeoutError" ? "timed out" : "network error" };
    }
    res.json({ ...connectionPayload(ctx, email), probe: outcome });
  });

  app.delete("/api/ciyuan-account", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    const user = identity(req);
    ciyuanAccount.disconnect(user?.email ?? null);
    await rewriteModelLane(ctx);
    reapplyMcp(ctx, user);
    res.json(connectionPayload(ctx, user?.email ?? null));
  });
}
