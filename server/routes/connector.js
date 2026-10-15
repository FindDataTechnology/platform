// Per-user 萬星 connector PAT API (connector-credentials, design D6;
// multi-account per add-connector-account-picker).
//
// Mirrors the registry credential routes' shape and rules: token write-only
// from the browser (projections carry state, never the token), reads/writes
// keyed to the requesting identity, auth off = the machine owner. An identity
// holds several connector accounts (slots); the active one is what profile
// writes inject. The paste endpoint adds the connector-specific double
// validation: an oct_ shape check plus a one-shot MCP initialize against the
// connector's entry URL — a 401 means the PAT is dead or wrong and is rejected
// outright; a network failure stores anyway (a connector outage must not block
// saving a credential).
//
// Zero-paste rows carry the connector-side PAT id; disconnect and same-slot
// replace revoke that PAT best-effort via the connector's own
// DELETE /api/tenant/pats/:id (bearer = the stored token). Failure is never
// fatal — a leftover PAT on the connector is the pre-picker status quo.

import { readFileSync } from "node:fs";
import path from "node:path";
import * as connectorCredentials from "../../connector-credentials.js";
import { getConnectorCredential } from "../../db.js";

const MCP_CONFIG_PATH = path.resolve(process.env.MCP_CONFIG_PATH || "mcp.json");

function identity(req) {
  return req.ssoUser || req.user || null;
}

// Anonymous writes are rejected in hosted mode, exactly like the registry
// credential routes: the row decides which PAT the runtime injects into the
// connector MCP connection, so it must belong to an authenticated user.
function requireOwner(req, res, ctx) {
  if (!ctx.authEnabled) return true;
  if (!identity(req)?.email) {
    res.status(401).json({ error: "Authentication is required" });
    return false;
  }
  return true;
}

// The connector server row from the operator baseline — the probe target and
// the single source of the connector's origin (never re-hardcoded here).
// null when the deployment's mcp.json has no connector row: pasting still
// works (shape check only), which keeps the credential path testable in
// fixtures and lets a self-hoster wire their own row whenever they want.
function connectorRow() {
  try {
    const row = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8")).mcpServers?.connector;
    return row && typeof row.url === "string" ? row : null;
  } catch {
    return null;
  }
}

function connectorOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function connectionPayload(email) {
  const row = connectorRow();
  const origin = row ? connectorOrigin(row.url) : null;
  return {
    ...connectorCredentials.status(email),
    // Deployment config, not a secret — where the card's "get a PAT" hint
    // sends the user (the connector's 我的连接 page).
    connectorUrl: origin,
    mePath: "/me",
  };
}

// One MCP initialize with the candidate PAT: 401 = definitively not accepted;
// anything else (200, 4xx other than 401, network error) leaves the decision
// to the store — the probe is advisory, the only hard verdict is a 401.
async function probeRejected(url, token) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "paas-connector-paste", version: "1" },
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.status === 401;
  } catch {
    return false;
  }
}

// Best-effort revocation of a zero-paste PAT (design D7): the mint response's
// PAT id + the stored token are enough to call the connector's own tenant
// route server-to-server. 404/401 (already gone/dead) and network errors are
// all swallowed — this must never block or fail the local operation.
async function revokeConnectorPat(origin, token, patId) {
  if (!origin || !token || !patId) return;
  try {
    await fetch(`${origin}/api/tenant/pats/${encodeURIComponent(patId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.warn(`[connector] best-effort PAT revocation failed: ${e.message}`);
  }
}

// A credential change IS an effective-profile change: the connector server
// appears (or disappears) at the next patch write, with no reinstall. Answer
// the request first and let the hot-swap settle in the background — the same
// shape the registry routes use.
function reapplyProfile(ctx, email, groups) {
  ctx
    .dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, groups, email)
    ?.catch((e) => console.warn(`[connector] profile update failed: ${e.message}`));
}

export function registerConnectorRoutes(ctx) {
  const { app, db } = ctx;

  app.get("/api/connector/connection", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Connector credentials are disabled (database unavailable)" });
    }
    res.json(connectionPayload(identity(req)?.email ?? null));
  });

  // All accounts of the requesting identity, token-free.
  app.get("/api/connector/connections", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Connector credentials are disabled (database unavailable)" });
    }
    const row = connectorRow();
    const origin = row ? connectorOrigin(row.url) : null;
    res.json({
      accounts: connectorCredentials.listForClient(identity(req)?.email ?? null),
      connectorUrl: origin,
      mePath: "/me",
    });
  });

  // Paste a PAT minted on the connector's 我的连接 page, or store one minted by
  // the zero-paste flow (which adds slot + patId). Shape first (oct_ prefix —
  // the connector's PAT kind), then the advisory liveness probe. Same-slot
  // replace revokes the old PAT when its id is on file.
  app.post("/api/connector/credential", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Connector credentials are disabled (database unavailable)" });
    }
    const { token, slot, patId } = req.body || {};
    if (typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ error: "Missing token" });
    }
    if (slot !== undefined && (typeof slot !== "string" || !slot.trim() || slot.trim().length > 64)) {
      return res.status(400).json({ error: "Invalid account name" });
    }
    if (patId !== undefined && patId !== null && typeof patId !== "string") {
      return res.status(400).json({ error: "Invalid patId" });
    }
    const value = token.trim();
    if (value.length > 8192) {
      return res.status(400).json({ error: "Token is too long" });
    }
    if (!value.startsWith("oct_")) {
      return res.status(400).json({ error: "That is not a connector PAT — personal access tokens start with oct_" });
    }
    const row = connectorRow();
    const origin = row ? connectorOrigin(row.url) : null;
    if (row && (await probeRejected(row.url, value))) {
      // The PAT itself answered 401: revoked or never valid. Never echoed back.
      return res.status(400).json({ error: "The connector rejected this PAT (revoked or invalid). Mint a fresh one on the 我的连接 page." });
    }
    const user = identity(req);
    const email = user?.email ?? null;
    const accountName = slot?.trim() || "default";
    // Same-slot replace: revoke the outgoing PAT before it's overwritten.
    const previous = connectorCredentials
      .list(email)
      .find((account) => account.slot === accountName);
    if (previous?.patId && origin) {
      const previousRow = getConnectorCredential(email, accountName);
      if (previousRow?.token) await revokeConnectorPat(origin, previousRow.token, previous.patId);
    }

    const status = connectorCredentials.store({
      email,
      slot: accountName,
      token: value,
      patId: typeof patId === "string" ? patId : null,
    });
    if (!status) {
      return res.status(500).json({ error: "Failed to store the credential" });
    }
    res.json(status);
    reapplyProfile(ctx, email, user?.groups ?? null);
  });

  // Explicit active-account switch (design D2: switching is always explicit).
  app.put("/api/connector/connection/active", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Connector credentials are disabled (database unavailable)" });
    }
    const { slot } = req.body || {};
    if (typeof slot !== "string" || !slot.trim()) {
      return res.status(400).json({ error: "Missing slot" });
    }
    const user = identity(req);
    const email = user?.email ?? null;
    const target = connectorCredentials.list(email).find((account) => account.slot === slot.trim());
    if (!target) {
      return res.status(404).json({ error: "No such account" });
    }
    if (target.stale) {
      return res.status(400).json({ error: "This account's token is stale — reconnect it first" });
    }
    if (!connectorCredentials.setActive(email, slot.trim())) {
      return res.status(500).json({ error: "Failed to switch the active account" });
    }
    res.json(connectionPayload(email));
    reapplyProfile(ctx, email, user?.groups ?? null);
  });

  // Disconnect one account: the row goes away, so the next profile write omits
  // the connector server if it was the active one (no auto-reselect — picking
  // the next account is the user's explicit move). Zero-paste PATs are
  // revoked best-effort first.
  app.delete("/api/connector/connection", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Connector credentials are disabled (database unavailable)" });
    }
    const user = identity(req);
    const email = user?.email ?? null;
    const slot = typeof req.query.slot === "string" && req.query.slot.trim() ? req.query.slot.trim() : "default";
    const row = connectorRow();
    const origin = row ? connectorOrigin(row.url) : null;
    const target = getConnectorCredential(email, slot);
    if (target?.token && target.patId && origin) {
      await revokeConnectorPat(origin, target.token, target.patId);
    }
    connectorCredentials.disconnect(email, slot);
    res.json({ ok: true, ...connectionPayload(email) });
    reapplyProfile(ctx, email, user?.groups ?? null);
  });
}
