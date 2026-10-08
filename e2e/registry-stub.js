// Hermetic registry stand-in for the fast e2e suite (registry-sso-credentials).
//
// The backend's registry bridge, the Store's market entries, and the connect
// popup's silent-SSO mint all need an mcp-gateway-registry. A real one lives at
// mcp.finddatatech.cloud; a test run must not depend on it (network, credentials,
// rate limits) nor leave the "no registry configured" branch as the only one
// covered. This stub serves the four endpoint groups the platform touches:
//
//   GET  /api/servers|skills|agents   bridge snapshot, service-token protected
//   GET  /login                       instant redirect back (the shared-Logto
//                                     pass-through, i.e. silent SSO)
//   GET  /api/auth/csrf-token         CSRF token for the mint (session cookie)
//   POST /api/tokens/generate          mints a 7-day JWT
//
// CORS mirrors what ops must configure on the real registry: this origin
// allow-listed WITH credentials, so the popup page can mint cross-origin.
// Cookies are SameSite=Lax, which the browser sends here because platform and
// stub share the 127.0.0.1 site (the production requirement — SameSite=None;
// Secure across real domains — is an ops task recorded in the change).
//
// Started by the Playwright webServer command in the SAME process group, so it
// dies with the run; never reached by the live project (which has no webServer).

import { createServer } from "node:http";

const PORT = Number(process.env.E2E_REGISTRY_PORT || 4599);
const SERVICE_TOKEN = process.env.MARKET_REGISTRY_TOKEN || "e2e-registry-token";
const SESSION_COOKIE = "e2e_registry_session";
const CSRF = "e2e-csrf-token";
const MCP_NAME = "e2e-registry-mcp";

// A decodable JWT (the platform reads `exp` only; the registry validates the
// signature and this stub has none).
function mintJwt(expiresInHours) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub: "e2e-user",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInHours * 3600,
  })}.e2e-signature`;
}

// Agent ENTRY store (agent-service-config e2e): the deploy/config surfaces
// upsert registry agent entries and read them back (GET-merge-PUT). The
// snapshot list below stays empty — entries live here keyed by their path
// WITHOUT the leading slash (the deploy lib registers "/packs/…" while URL
// routing yields "packs/…" — one normalization for both).
const agentEntries = new Map();
const normPath = (p) => String(p ?? "").replace(/^\/+/, "");
const readBody = (req) =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-csrf-token");
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function hasSession(req) {
  return String(req.headers.cookie || "").includes(`${SESSION_COOKIE}=1`);
}

function serviceAuthorized(req) {
  return req.headers.authorization === `Bearer ${SERVICE_TOKEN}`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  cors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── bridge snapshot (service token) ───────────────────────────────────────
  if (url.pathname.startsWith("/api/servers") || url.pathname.startsWith("/api/skills") || url.pathname.startsWith("/api/agents")) {
    if (!serviceAuthorized(req)) return json(res, 401, { detail: "Unauthorized" });
    if (url.pathname.startsWith("/api/servers")) {
      return json(res, 200, {
        servers: [
          {
            path: `/${MCP_NAME}`,
            display_name: "E2E Registry MCP",
            description: "Registry entry served by the e2e stub",
            is_enabled: true,
            health_status: "healthy",
            status: "active",
            tags: ["e2e"],
          },
          // Second entry (add-persona-resource-sets): pack manifests need TWO
          // installable registry references for the declared-subset e2e — one
          // the declaration keeps, one it drops.
          {
            path: `/${MCP_NAME}-2`,
            display_name: "E2E Registry MCP 2",
            description: "Registry entry served by the e2e stub",
            is_enabled: true,
            health_status: "healthy",
            status: "active",
            tags: ["e2e"],
          },
        ],
        total_count: 2,
      });
    }
    if (url.pathname.startsWith("/api/skills")) return json(res, 200, { skills: [], total_count: 0 });
    // Agent entries (agent-service-config): the deploy surface registers one
    // per serving role and the config write is a GET-merge-PUT onto it.
    if (url.pathname === "/api/agents/register" && req.method === "POST") {
      return void readBody(req).then((body) => {
        agentEntries.set(normPath(body.path), body);
        json(res, 201, { path: body.path, ...body });
      });
    }
    const toggle = url.pathname.match(/^\/api\/agents\/(.+)\/toggle$/);
    if (toggle && req.method === "POST") {
      return json(res, 200, { path: toggle[1], is_enabled: true });
    }
    const entry = url.pathname.match(/^\/api\/agents\/(.+)$/);
    if (entry) {
      const key = normPath(entry[1]);
      if (req.method === "GET") {
        if (!agentEntries.has(key)) return json(res, 404, { detail: "not found" });
        return json(res, 200, agentEntries.get(key));
      }
      if (req.method === "PUT") {
        // The real registry (FastAPI) parses strictly: a body without an
        // application/json content-type arrives as text and 422s. Mirror
        // that so the config write's GET-merge-PUT header discipline is
        // exercised end to end (live probe 2026-10-07 — headerless 422).
        if (!String(req.headers["content-type"] || "").includes("application/json")) {
          return json(res, 422, {
            detail: [{ type: "model_attributes_type", loc: ["body"], msg: "Input should be a valid dictionary or object to extract fields from" }],
          });
        }
        return void readBody(req).then((body) => {
          agentEntries.set(normPath(body.path ?? key), body);
          json(res, 200, { path: body.path ?? key, ...body });
        });
      }
    }
    return json(res, 200, { agents: [], total_count: 0 });
  }

  // ── connect popup: login leg ──────────────────────────────────────────────
  // The shared-identity pass-through: a real registry would send an
  // unauthenticated visitor to Logto and come back here. Either way the effect
  // is "redirect straight back", which is what the silent path looks like.
  if (url.pathname === "/login") {
    const back = url.searchParams.get("redirect_uri") || url.searchParams.get("redirect") || "/";
    res.writeHead(302, {
      Location: back,
      "Set-Cookie": `${SESSION_COOKIE}=1; Path=/; SameSite=Lax; HttpOnly`,
    });
    res.end();
    return;
  }

  // ── connect popup: mint leg (session cookie + CSRF, like the real API) ────
  if (url.pathname === "/api/auth/csrf-token") {
    if (!hasSession(req)) return json(res, 401, { detail: "No session" });
    return json(res, 200, { csrf_token: CSRF });
  }
  if (url.pathname === "/api/tokens/generate" && req.method === "POST") {
    if (!hasSession(req)) return json(res, 401, { detail: "No session" });
    if (req.headers["x-csrf-token"] !== CSRF) return json(res, 403, { detail: "Bad CSRF token" });
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let hours = 168;
      try {
        hours = Number(JSON.parse(body || "{}").expires_in_hours) || hours;
      } catch { /* default TTL */ }
      json(res, 200, { access_token: mintJwt(hours), token_type: "Bearer", expires_in: hours * 3600 });
    });
    return;
  }

  json(res, 404, { detail: `No route for ${url.pathname}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[e2e-registry-stub] listening on http://127.0.0.1:${PORT}`);
});
