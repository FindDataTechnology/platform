// External-service proxy for catalog-declared embedded apps.
//
// Embeds external-service apps from the catalog (agents.json) behind a
// token-injecting reverse proxy at /external/:appId. A server-held token is
// injected into the upstream request; the browser never sees the upstream URL
// or its credentials. The app's catalog entry determines whether to embed in an
// iframe (embedded !== false) or open in a new tab.
//
// Per-app credentials resolution:
//   - `apiKeyEnv` → process.env[apiKeyEnv] (preferred; never reaches the client)
//   - `apiKey`    → literal value (NOT serialized to the client; only available
//                    here on the server where the catalog is read at startup)
//   - missing     → no Authorization header sent (public upstream)
//
// Authenticated by the same forward-auth gate as the rest of the app; the
// embedded page lives on a same-origin /external/:appId path so the iframe
// inherits the session cookie when applicable.

// Generic token-injecting reverse proxy for embedding an external web UI
// same-origin in an <iframe>. Forwards method/body/query to getBase() + the
// upstream path, injects `Authorization: Bearer <getToken(upstream)>`, strips
// any client-supplied Authorization, injects a <base href="<prefix>/"> tag into
// HTML so relative assets resolve under the proxy prefix, rewrites Location
// redirects to stay under <prefix>, and drops content-encoding/length (Node's
// fetch decompresses the body; express recomputes length).
function createWebProxy({ prefix, getBase, getToken, label = "Upstream" }) {
  const pathRe = new RegExp(`^${prefix}`);
  return async function webProxy(req, res) {
    const base = getBase();
    let upstream = req.originalUrl.replace(pathRe, "");
    if (upstream === "") upstream = "/";
    const url = base + upstream;

    // A client-supplied Authorization header is forwarded (so upstream session
    // tokens work end-to-end); when absent, the server-held token is injected.
    // This keeps the server-held credential off the wire when a per-request
    // token is provided.
    const ct = req.headers["content-type"];
    const reqHeaders = {};
    if (ct) reqHeaders["content-type"] = ct;
    if (req.headers.authorization) {
      reqHeaders.authorization = req.headers.authorization;
    } else {
      const token = getToken(upstream);
      if (token) reqHeaders.authorization = `Bearer ${token}`;
    }

    // JSON bodies were parsed by express.json → stringify; other content types
    // (multipart, form) are read raw from the stream.
    let body;
    const hasBody = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    if (hasBody) {
      const isJson = (ct || "").includes("application/json");
      if (isJson && req.body !== undefined) {
        body = JSON.stringify(req.body);
      } else if (!isJson) {
        const chunks = [];
        await new Promise((resolve, reject) => {
          req.on("data", (c) => chunks.push(c));
          req.on("end", resolve);
          req.on("error", reject);
        });
        body = Buffer.concat(chunks);
      }
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(url, {
        method: req.method,
        headers: reqHeaders,
        body,
        redirect: "manual",
      });
    } catch (err) {
      return res.status(502).send(`${label} unreachable: ${err.message}`);
    }

    res.status(upstreamRes.status);
    const respType = upstreamRes.headers.get("content-type") || "";
    if (respType) res.setHeader("content-type", respType);
    const loc = upstreamRes.headers.get("location");
    if (loc) {
      try {
        const u = new URL(loc, base);
        res.setHeader("location", `${prefix}${u.pathname}${u.search}`);
      } catch {
        res.setHeader("location", loc);
      }
    }

    // content-encoding/content-length are intentionally NOT forwarded: Node's
    // fetch decompresses the body, so forwarding them would corrupt it.
    let buf;
    try {
      buf = Buffer.from(await upstreamRes.arrayBuffer());
    } catch (err) {
      return res.status(502).send(`${label} response read failed: ${err.message}`);
    }

    if (respType.includes("text/html")) {
      let html = buf.toString("utf8");
      const baseTag = `<base href="${prefix}/">`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/(<head[^>]*>)/i, `$1${baseTag}`);
      } else {
        html = baseTag + html;
      }
      return res.type("text/html").send(html);
    }

    res.send(buf);
  };
}

export function registerExternalServiceRoutes(ctx) {
  const { app, catalog } = ctx;

  // Register a /external/:appId proxy for every external-service in the
  // catalog. Registered AFTER the app's own /api/* routes so those win on
  // conflict. Unknown /external/:appId values 404 — getExternalServices() is
  // the only source of truth, so a stale link in the browser fails fast.
  for (const svc of catalog.getExternalServices()) {
    // catalog.js never serializes apiKey/apiKeyEnv to the client (spec D5 —
    // tokens never reach the browser), so this lookup runs server-side only.
    const apiKey = (svc.apiKeyEnv && process.env[svc.apiKeyEnv]) || svc.apiKey || null;
    const proxy = createWebProxy({
      prefix: `/external/${svc.id}`,
      getBase: () => svc.url,
      getToken: () => apiKey,
      label: svc.name || svc.id,
    });
    app.all(`/external/${svc.id}`, proxy);
    app.all(`/external/${svc.id}/*`, proxy);
  }
}
