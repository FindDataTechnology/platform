// Hermetic facet stand-in for the fast e2e suite
// (pack-install-server-side-manifest).
//
// The install endpoint resolves the pack manifest SERVER-side over the facet
// channel (/api/packs* proxy construction: FACET_BASE_URL + internal token +
// forwarded x-facet-user identity). A real facet lives at
// facet.finddatatech.cloud behind a hostNetwork deployment; the suite must not
// depend on it, so this stub answers exactly the one route the install fetch
// uses — GET /api/packs/:id/versions/:version — with the same visibility rule
// the market enforces (private ⇒ author/admin only, otherwise not-found) and
// the same token-gated identity semantics as facet/identity.js (a forwarded
// header without the internal credential is ignored).
//
// Control routes (used by the specs to seed packs and provoke failures):
//   POST /__seed  {id, version, manifest, visibility?, authorEmail?}
//   POST /__mode  {id, version, mode}   mode: ok | 500 | no-manifest
//   POST /__reset
//   GET  /__seen                        every data request + its headers
//
// Started by the Playwright webServer command in the SAME process group, so
// it dies with the run; never reached by the live project (no webServer).

import { createServer } from "node:http";

// 4601: 4597 is the search-relay reference service's loopback default and
// 4599 the registry stub — both may already be running on a dev machine.
const PORT = Number(process.env.E2E_FACET_PORT) || 4601;
const TOKEN = process.env.FACET_INTERNAL_TOKEN || process.env.E2E_FACET_TOKEN || "e2e-facet-token";

const packs = new Map(); // "id@version" → { manifest, visibility, authorEmail, mode }
const seen = []; // { path, headers }

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/__seed" && req.method === "POST") {
    const b = await readBody(req);
    packs.set(`${b.id}@${b.version}`, {
      manifest: b.manifest,
      visibility: b.visibility === "private" ? "private" : "public",
      authorEmail: b.authorEmail || "creator@e2e.test",
      mode: b.mode || "ok",
    });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/__mode" && req.method === "POST") {
    const b = await readBody(req);
    const entry = packs.get(`${b.id}@${b.version}`);
    if (!entry) return json(res, 404, { error: "unknown pack" });
    entry.mode = b.mode;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/__reset" && req.method === "POST") {
    packs.clear();
    seen.length = 0;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/__seen" && req.method === "GET") {
    return json(res, 200, { seen });
  }

  const m = url.pathname.match(/^\/api\/packs\/([^/]+)\/versions\/([^/]+)$/);
  if (!m) return json(res, 404, { error: "not found" });
  seen.push({ path: url.pathname, headers: req.headers });

  // Proxy-channel identity: honored only under the internal credential.
  let viewer = null;
  if (req.headers["x-facet-token"] === TOKEN && req.headers["x-facet-user"]) {
    try {
      viewer = JSON.parse(Buffer.from(String(req.headers["x-facet-user"]), "base64url").toString("utf8"));
    } catch {
      viewer = null;
    }
  }

  const id = decodeURIComponent(m[1]);
  const version = decodeURIComponent(m[2]);
  const pack = packs.get(`${id}@${version}`);
  if (!pack) return json(res, 404, { error: "Pack version not found" });
  if (pack.visibility === "private" && viewer?.email !== pack.authorEmail) {
    return json(res, 404, { error: "Pack version not found" });
  }
  if (pack.mode === "500") return json(res, 500, { error: "internal" });
  if (pack.mode === "no-manifest") return json(res, 200, { id, version: Number(version) });
  return json(res, 200, { id, version: Number(version), manifest: pack.manifest });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[e2e-facet-stub] listening on http://127.0.0.1:${PORT}`);
});