// ── Machine surfaces on the supply-domain front door ────────────────────────
//
// unify-supply-spine-lineage D3 (2026-11-21) inverts this file's contract.
// It used to answer 404 for the four machine paths, because the machine
// surfaces belonged to a separate static plaza host and a host that does not
// OWN a surface must not fake one. That plaza host is now this process: the
// front door owns `/llms.txt`, `/llms-full.txt`, `/catalog.json`, `/robots.txt`
// and the per-material pages, so the guard's job is the opposite one — it must
// make sure these paths can never be answered by the SPA shell.
//
// Three states, and the middle one is the whole point:
//
//   owns + file present  → next()  (the static handler serves the real bytes)
//   owns + file MISSING  → 503 text/plain, never next()
//   does not own         → 404 text/plain (a host with no surface must not
//                          answer with HTML — the compatibility door keeps
//                          this branch, see FRONT_DOOR_HOSTS below)
//
// The 503 is not pedantry. Falling through to the catch-all produced a soft
// 200 carrying index.html, which to a crawler is indistinguishable from a real
// machine face — the silent-failure shape this whole area exists to prevent.
// A 503 says "I own this and I cannot serve it right now", which is true.

/** The machine surfaces a crawler asks any host for, verbatim. */
import { statSync } from "node:fs";

export const MACHINE_SURFACE_PATHS = Object.freeze([
  "/llms.txt",
  "/llms-full.txt",
  "/catalog.json",
  "/robots.txt",
]);

/**
 * True when a request path names a machine surface. Matching is
 * case-insensitive and ignores a trailing slash: `/LLMS.TXT/` is the same
 * question as `/llms.txt`, and answering it wrongly is the same defect.
 * Query strings never reach here (`req.path` excludes them).
 */
export function isMachineSurfacePath(rawPath) {
  const p = String(rawPath ?? "");
  const trimmed = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  return MACHINE_SURFACE_PATHS.includes(trimmed.toLowerCase());
}

/** The on-disk name of each surface inside the site root. */
const SURFACE_FILES = Object.freeze({
  "/llms.txt": "llms.txt",
  "/llms-full.txt": "llms-full.txt",
  "/catalog.json": "catalog.json",
  "/robots.txt": "robots.txt",
});

/** Resolve the surface path to its file inside `siteRoot`, or null. */
export function machineSurfaceFile(rawPath, siteRoot) {
  const p = String(rawPath ?? "");
  const trimmed = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  const file = SURFACE_FILES[trimmed.toLowerCase()];
  if (!file) return null;
  // Two accepted locations, same generation: the site root (what the deploy
  // script stages and the compatibility door serves) and `generated/` (what a
  // fresh seed or an interrupted stage leaves behind). The root wins because
  // it is the published one; falling back keeps a freshly seeded deployment
  // from answering 503 for content it demonstrably has.
  return { file, path: `${siteRoot}/${file}`, fallbackPath: `${siteRoot}/generated/${file}` };
}

/** The first of the candidate locations that exists, or null. */
function resolveExisting(target, fileExists) {
  if (target.path && fileExists(target.path)) return target.path;
  if (target.fallbackPath && fileExists(target.fallbackPath)) return target.fallbackPath;
  return null;
}

/**
 * Express middleware for the owning host.
 *
 * @param {object} opts
 * @param {string} opts.siteRoot  where the generated surfaces live
 * @param {(p: string) => boolean} [opts.exists]  test seam (defaults to fs)
 * @param {number} [opts.statusWhenMissing]  default 503
 */
export function machineSurfaceGuard({ siteRoot = "", exists, statusWhenMissing = 503 } = {}) {
  const fileExists = exists ?? ((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
  return function machineSurfaceGuardMw(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const target = machineSurfaceFile(req.path, siteRoot);
    const resolved = target ? resolveExisting(target, fileExists) : null;
    if (!target) {
      // Not a machine path at all — human routes fall through untouched.
      if (!isMachineSurfacePath(req.path)) return next();
      return res.status(404).type("text/plain").send("");
    }
    if (!resolved) {
      return res
        .status(statusWhenMissing)
        .type("text/plain")
        .send(`machine surface unavailable: ${target.file}\n`);
    }
    // Serve here rather than next(): a case-insensitive or trailing-slash
    // variant (`/LLMS.TXT`) names a real surface, but express.static would
    // look for that literal filename and, not finding it on a case-sensitive
    // filesystem, fall through to the SPA catch-all — the soft 200 this guard
    // exists to prevent.
    return res.sendFile(resolved);
  };
}
