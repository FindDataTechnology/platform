// Connector binding routes (add-connector-bindings D6/D7).
//
// The status face, the declarative grant, the progressive grant and revoke.
// Shapes follow the connector credential routes next door: identity-scoped,
// token-free projections, auth-required in hosted mode, auth off = the machine
// owner. Nothing here returns a token or a PAT id to the browser — the scope and
// the state are the UI's business, the credential is not.

import * as bindings from "../../connector-bindings.js";
import * as grants from "../../connector-grants.js";
import * as db from "../../db.js";

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

function dbReady(res, ctx) {
  if (ctx.db.isDbReady()) return true;
  res.status(503).json({ error: "Connector bindings are disabled (database unavailable)" });
  return false;
}

// The client-facing projection of one binding: what the pack asked for, what the
// world says, and what the user must do next. Deliberately no token, no PAT id,
// no connection id (an id is a handle; the name is what a human recognizes).
function projectRow(row) {
  return {
    packId: row.packId,
    bindingKey: row.bindingKey,
    provider: row.provider,
    operations: row.operations,
    connectionName: row.connectionName ?? null,
    connectionVirtual: !!row.connectionVirtual,
    status: row.status,
    reason: row.reason,
    optional: !!row.optional,
    // A role binding's identity face: the role name it needs and whether the
    // provider column holds a role rather than a system. The UI picks its copy
    // and its action ("选择你的系统" vs "去连接") off these two, so they travel
    // with every binding row, not only on the connections page.
    role: row.role ?? null,
    providerRole: Boolean(row.role),
    grantedAt: row.grantedAt ?? null,
    packVersion: row.packVersion ?? null,
  };
}

export function registerConnectorBindingRoutes(ctx) {
  const { app } = ctx;
  const owner = (req) => identity(req)?.email ?? null;

  // Every binding this identity has a ledger row for (optionally one pack).
  app.get("/api/connector/bindings", (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    const email = owner(req);
    const packId = typeof req.query.packId === "string" ? req.query.packId : null;
    res.json({
      bindings: bindings
        .listBindings(email, packId)
        .map((row) => projectRow({ ...row, connectionName: null })),
    });
  });

  // Re-resolve a pack's bindings against the connector right now (the surface's
  // refresh, and what install/activate call server-side).
  app.post("/api/connector/bindings/refresh", async (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : "";
    if (!packId) return res.status(400).json({ error: "packId is required" });
    const result = await grants.refreshPackBindings({ email: owner(req), packId });
    if (!result.ok) return res.status(404).json({ error: "pack is not installed", code: result.code });
    res.json({ gate: result.gate, bindings: result.bindings.map(projectRow) });
  });

  // The declarative grant: one confirmation, every resolvable binding of the
  // pack. The body may narrow the set (bindingKeys) but never widen it.
  app.post("/api/connector/bindings/grant", async (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : "";
    if (!packId) return res.status(400).json({ error: "packId is required" });
    const bindingKeys = Array.isArray(req.body?.bindingKeys) ? req.body.bindingKeys.filter((k) => typeof k === "string") : null;
    const result = await grants.grantPack({ email: owner(req), packId, bindingKeys });
    if (result.granted.length === 0 && result.failed.length === 0) {
      return res.status(404).json({ error: "no bindings to grant", code: "no_bindings" });
    }
    if (result.granted.length === 0) {
      // Nothing was granted: name why (the first failure is the actionable one).
      return res.status(409).json({ error: "no binding could be granted", code: result.failed[0]?.code ?? "grant_failed", failed: result.failed });
    }
    res.json({ granted: result.granted, failed: result.failed });
  });

  // Progressive grant: one action was rejected for scope; widen the binding that
  // owns it. The rejected call is NOT replayed here.
  app.post("/api/connector/bindings/grant-for-action", async (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : "";
    const actionId = typeof req.body?.actionId === "string" ? req.body.actionId : "";
    if (!packId || !actionId) return res.status(400).json({ error: "packId and actionId are required" });
    const result = await grants.grantForAction({ email: owner(req), packId, actionId });
    if (!result.ok) {
      const status = result.code === "unknown_action" ? 404 : result.code === "not_grantable" ? 400 : 409;
      return res.status(status).json({ error: "grant not applied", ...result });
    }
    res.json(result);
  });

  // Revoke one binding: connector-side PAT (best effort) + local rows.
  app.post("/api/connector/bindings/revoke", async (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : "";
    const bindingKey = typeof req.body?.bindingKey === "string" ? req.body.bindingKey : "";
    if (!packId || !bindingKey) return res.status(400).json({ error: "packId and bindingKey are required" });
    const result = await grants.revokeBinding({ email: owner(req), packId, bindingKey });
    res.json({
      revoked: result.removed,
      revokedOnConnector: result.revokedOnConnector,
      status: bindings.listBindings(owner(req), packId).find((row) => row.bindingKey === bindingKey)?.status ?? null,
    });
  });

  // ── Role mappings (add-connector-role-mapping D8) ─────────────────────────
  //
  // A role binding says "this pack needs a WMS"; the identity says "mine is
  // wangdian". These three routes are that second sentence: read what each role
  // the installed packs actually need is mapped to, choose a system, or go back
  // to unchosen.
  //
  // The candidate list is the user's OWN connections narrowed by catalog
  // coverage — never the catalog. An unchosen system without an account cannot
  // be used, so offering 1570 providers would disguise a configuration step as
  // a product choice. Systems that ARE connected but under-cover come back in
  // `rejected` with their gaps, so the card can say why instead of hiding them.

  const ROLE_MAX = 64;
  const PROVIDER_MAX = 128;

  function roleName(value) {
    const role = typeof value === "string" ? value.trim() : "";
    return role && role.length <= ROLE_MAX ? role : null;
  }

  // One response may ask about several roles; the connections call and each
  // (service, classes) coverage answer are identical across them, so they are
  // memoized for the life of ONE request. Nothing is cached across requests —
  // the connector is the authority, and a stale list would offer a system the
  // user just disconnected.
  function memoClient(client) {
    if (!client) return null;
    let connections = null;
    const coverage = new Map();
    return {
      origin: client.origin,
      coverage(provider, operations) {
        const key = `${provider}|${operations.join(",")}`;
        if (!coverage.has(key)) coverage.set(key, client.coverage(provider, operations));
        return coverage.get(key);
      },
      connections() {
        connections = connections ?? client.connections();
        return connections;
      },
    };
  }

  async function describeRoles(email) {
    const mapped = new Map(db.listConnectorRoleMappings(email).map((row) => [row.role, row]));
    const client = memoClient(bindings.tenantClient(email));
    const mappings = [];
    for (const declared of bindings.declaredRoles(email)) {
      const mapping = mapped.get(declared.role) ?? null;
      // Unreachable self-introspection must not read as "you can choose from
      // nothing": report the state, and leave an empty list that the card can
      // tell apart from "your connections cover none of these".
      const candidates = await bindings.roleCandidates({ operations: declared.operations, client });
      mappings.push({
        role: declared.role,
        operations: declared.operations,
        packs: declared.packs,
        optional: declared.optional,
        provider: mapping?.provider ?? null,
        updatedAt: mapping?.updatedAt ?? null,
        candidates: candidates.candidates,
        rejected: candidates.rejected,
        candidatesState: candidates.ok ? { ok: true } : { ok: false, code: candidates.code },
      });
    }
    return mappings;
  }

  app.get("/api/connector/role-mappings", async (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    res.json({ mappings: await describeRoles(owner(req)) });
  });

  app.put("/api/connector/role-mappings/:role", async (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    const role = roleName(req.params.role);
    if (!role) return res.status(400).json({ error: "role is required", code: "invalid_role" });
    const provider = typeof req.body?.provider === "string" ? req.body.provider.trim() : "";
    if (!provider || provider.length > PROVIDER_MAX) {
      return res.status(400).json({ error: "provider is required", code: "invalid_provider" });
    }
    // Deliberately no catalog existence check here: a provider the catalog does
    // not know is a *resolution* answer (`unwired` + "unknown provider" + a
    // change-system entry), not a malformed request. The resolver says so.
    //
    // The role, however, must be one some installed pack actually declares:
    // storing a choice for a role nobody needs would answer 200 and change
    // nothing, which reads as success. DELETE stays permissive on purpose — a
    // mapping left behind by an uninstalled pack still has to be clearable.
    const declared = bindings.declaredRoles(owner(req));
    if (!declared.some((entry) => entry.role === role)) {
      return res.status(404).json({ error: "role is not declared by any installed pack", code: "role_not_declared" });
    }
    const mapping = db.setConnectorRoleMapping(owner(req), role, provider);
    if (!mapping) return res.status(500).json({ error: "mapping was not stored", code: "store_failed" });
    const refresh = await grants.refreshRoleBindings({ email: owner(req), role });
    res.json({ ok: true, mapping, refresh: projectRefresh(refresh) });
  });

  app.delete("/api/connector/role-mappings/:role", async (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    const role = roleName(req.params.role);
    if (!role) return res.status(400).json({ error: "role is required", code: "invalid_role" });
    const deleted = db.deleteConnectorRoleMapping(owner(req), role);
    const refresh = await grants.refreshRoleBindings({ email: owner(req), role });
    res.json({ ok: true, deleted, mapping: null, refresh: projectRefresh(refresh) });
  });
}

/**
 * The recompute that a mapping change triggers, as the browser needs it: the
 * affected packs and their rows, token-free. Same shape as the refresh route's
 * payload so the card can reuse one renderer.
 */
function projectRefresh(result) {
  return {
    ok: !!result?.ok,
    ...(result?.code ? { code: result.code } : {}),
    packs: (result?.packs ?? []).map((pack) => ({
      packId: pack.packId,
      ok: !!pack.ok,
      ...(pack.code ? { code: pack.code } : {}),
      ...(pack.gate ? { gate: pack.gate } : {}),
      ...(pack.bindings ? { bindings: pack.bindings.map(projectRow) } : {}),
    })),
  };
}
