// ── Facet pairing surface (add-facet-publish-bridge, F3.2) ────────────────────
//
// The publish bridge's login, mounted on the facet service: the same
// device-pairing doors the 壹座 gateway exposes (app-auth.js — third outing
// verbatim after the gateway and the single-process server), so a CLI can
// pair against the OFFICIAL MARKET'S OWN DOMAIN and publish under its
// account identity. Nothing here is facet-specific logic: bindings live in
// the facet data root (the file-persistence convention, one JSON file),
// the bind-code pool is minted from the facet session, and the token
// secret rides the same MP_TOKEN_SECRET gate — unset ⇒ the doors answer
// an honest 503 and the rest of the facet surface is untouched.
//
// withAppBearer composes the third identity channel: base resolution
// (壹座 proxy → direct session) first, then a Bearer app token — the same
// order the gateway's resolveUser uses (session before Bearer there; a
// request never meaningfully carries both here). accountFromToken only
// accepts kind="app" tokens, so MP tokens minted for other surfaces never
// impersonate on this one.

import path from "node:path";
import express from "express";
import { createAppAuth } from "../gateway/app-auth.js";
import { createMpBindings } from "../gateway/mp-bindings.js";

export function createFacetPairing({ dataRoot, tokenSecret, ttlHours = 12 }) {
  const bindings = createMpBindings({ file: path.join(dataRoot, "bindings.json") });
  const appAuth = createAppAuth({ tokenSecret, ttlHours, bindings });
  return { bindings, appAuth };
}

export function withAppBearer(baseResolve, appAuth) {
  return function resolveUser(req) {
    const viaBase = baseResolve(req);
    if (viaBase) return viaBase;
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
    return appAuth.accountFromToken(auth.slice(7));
  };
}

// The five doors, mirroring gateway/index.js verbatim in behavior. The
// bind-code page's copy faces the CLI author (the gateway's page faces the
// mini-program user) — same minting pool semantics, single-use 5-minute code.
export function registerPairingRoutes(app, { appAuth, mpBindings, resolveUser, rejectUnauthenticated }) {
  app.get("/api/mp/bindcode", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const { code, ttlMs } = mpBindings.issueBindCode(user.email, user.groups ?? []);
    if (req.accepts("json") && !req.accepts("html")) {
      return res.json({ code, ttlMs });
    }
    res.type("html").send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CLI 发布配对码</title>
<body style="font-family:system-ui;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#f3f4f6">
  <div style="text-align:center;background:#fff;padding:48px 64px;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,.08)">
    <div style="color:#6b7280;font-size:14px">facet CLI · 发布配对码（${user.email}）</div>
    <div style="font-size:56px;letter-spacing:12px;font-weight:700;color:#111827;margin:24px 0">${code}</div>
    <div style="color:#9ca3af;font-size:13px">5 分钟内有效，一次性使用。回到终端，把这 6 位数输入 facet publish 的提示即可完成配对。</div>
    <div style="margin-top:20px"><a href="/api/mp/bindcode" style="color:#2563eb;font-size:14px">刷新新码</a></div>
  </div>
</body>`);
  });

  app.post("/api/app/pair", express.json(), async (req, res) => {
    const r = await appAuth.pair(req.body ?? {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ token: r.token, email: r.email });
  });

  app.post("/api/app/challenge", express.json(), (req, res) => {
    const r = appAuth.challenge(req.body ?? {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ nonce: r.nonce, ttlMs: r.ttlMs });
  });

  app.post("/api/app/login", express.json(), (req, res) => {
    const r = appAuth.login(req.body ?? {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ token: r.token, email: r.email });
  });

  app.get("/api/app/devices", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    res.json(appAuth.devicesFor(user.email));
  });

  app.delete("/api/app/bind/:deviceId", async (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const r = await appAuth.revoke(user.email, String(req.params?.deviceId ?? ""));
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json(r);
  });
}
