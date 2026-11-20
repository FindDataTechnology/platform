// ── Team console share proxy (add-pack-console) ─────────────────────────────
//
// The facet's ONE read path to 壹座's public team-console endpoint. It exists
// because the share page is served from the facet domain, where `/api/*` is the
// facet's own API — a browser fetch to `/api/fleets/...` would never reach the
// platform.
//
// Posture, spelled out because each part is a decision:
//   · FORWARDS NO IDENTITY. The share page is anonymous; the platform decides
//     from the slug alone and answers 404 for anything unpublished. Forwarding a
//     visitor's headers would invent an authority the page does not have.
//   · PASSES THE STATUS THROUGH unchanged. A 404 means "not published" and must
//     stay a 404 — rewriting it to 503 would tell a visitor to retry something
//     that will never work.
//   · DEGRADES TO 503, NEVER TO AN EMPTY CONSOLE. If the platform is
//     unreachable the page says "temporarily unavailable"; an empty console would
//     read as "this team has nothing to show", which is a different (and false)
//     statement.
//   · SCOPED. The market plane (packs/detail/downloads) uses other routes, so
//     the facet-platform independence promise is untouched by this proxy.

export const TEAM_CONSOLE_TIMEOUT_MS = 3000;

/**
 * Mount `GET /api/team-console/:slug` on an express app.
 *
 * @param {import("express").Express} app
 * @param {object} opts
 * @param {string} [opts.baseUrl]  platform base (no trailing slash)
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl] test seam
 */
export function registerTeamConsoleProxy(app, { baseUrl, timeoutMs = TEAM_CONSOLE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");

  app.get("/api/team-console/:slug", async (req, res) => {
    const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
    if (!slug) return res.status(404).json({ error: "Not published" });
    if (!base) return res.status(503).json({ error: "console source not configured" });
    try {
      const target = `${base}/api/fleets/by-slug/${encodeURIComponent(slug)}/console?surface=share&slug=${encodeURIComponent(slug)}`;
      // No visitor headers travel with this call: the share page holds no
      // authority of its own.
      const upstream = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs) });
      res.status(upstream.status).type("json").send(await upstream.text());
    } catch (err) {
      res.status(503).json({ error: `console source unreachable (${err?.message || err})` });
    }
  });
}
