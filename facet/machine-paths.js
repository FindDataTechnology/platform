// ── Machine-surface paths that the facet shell must NOT answer ──────────────
//
// fix-supply-machine-faces D1: exactly one host owns the machine surfaces —
// the plaza host (agent.finddatatech.cloud). This host (the facet shell,
// facet.finddatatech.cloud) owns none of them, and the SPA catch-all used to
// answer every non-API path with index.html, so an agent asking for
// /llms.txt received 200 text/html: a soft success indistinguishable from a
// real machine face.
//
// The guard below is consulted before the static handler and before the
// catch-all, so these four paths can only ever be a 404 here. Keep this list
// and the plaza's published surface list in step: adding a surface there
// without adding it here leaves a masking soft-200 behind.

/** The machine surfaces a crawler asks any host for, verbatim. */
export const MACHINE_SURFACE_PATHS = Object.freeze([
  "/llms.txt",
  "/llms-full.txt",
  "/catalog.json",
  "/robots.txt",
]);

/**
 * True when a request path names a machine surface. Matching is
 * case-insensitive and ignores a trailing slash: `/LLMS.TXT/` is the same
 * question as `/llms.txt`, and answering it with HTML is the same defect.
 * Query strings never reach here (`req.path` excludes them).
 */
export function isMachineSurfacePath(rawPath) {
  const p = String(rawPath ?? "");
  const trimmed = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  return MACHINE_SURFACE_PATHS.includes(trimmed.toLowerCase());
}

/**
 * Express middleware: answer a machine-surface GET/HEAD with an empty
 * text/plain 404 and never fall through to the shell. Other methods are
 * passed on untouched (a write to /llms.txt is not a surface read; the API
 * plane owns whatever error it wants to give).
 */
export function machineSurfaceGuard() {
  return function machineSurfaceGuardMw(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (!isMachineSurfacePath(req.path)) return next();
    res.status(404).type("text/plain").send("");
  };
}
