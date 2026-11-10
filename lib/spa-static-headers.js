// lib/spa-static-headers.js — the SPA shell's cache posture (openspec:
// harden-spa-shell-resilience, web-shell-resilience「SPA 壳保持新鲜」).
//
// One zero-dependency leaf module owns the rule both servers (gateway/index.js
// and the single-process server/routes/misc.js) apply, so the two surfaces
// cannot drift: the shell (index.html and every non-hashed file) is always
// revalidated (`no-cache`), and Vite's content-hashed build output under
// `assets/` is cached forever (`immutable`). Without this, browsers apply
// heuristic caching to the shell: after a rollout an old tab keeps an old
// index.html that names chunks the new dist no longer has — the lazy import
// 404s and, with no error boundary at the time, the whole app blanked
// (observed 2026-11-02: 智语 intermittent white screen after a rollout).
//
// Vite emits hashed files as `<name>-<hash>.<ext>` (hash: 8+ chars of the
// URL-safe base64 alphabet). Anything under `assets/` without that shape —
// and everything outside `assets/` — is treated as shell-adjacent and gets
// `no-cache`.

/** Cache-Control for content-hashed build output. */
export const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Cache-Control for the SPA shell and every non-hashed file. */
export const SHELL_CACHE_CONTROL = "no-cache";

// `<name>-<8+ chars of [A-Za-z0-9_-]>.<ext>` — Vite's default chunk naming.
const HASHED_RE = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** True when `filePath` is a content-hashed file under `assets/`. */
export function isHashedAsset(filePath) {
  const norm = String(filePath).split("\\").join("/");
  return norm.includes("/assets/") && HASHED_RE.test(norm);
}

/** The Cache-Control value the platform serves `filePath` with. */
export function spaCacheControlFor(filePath) {
  return isHashedAsset(filePath) ? HASHED_ASSET_CACHE_CONTROL : SHELL_CACHE_CONTROL;
}

/**
 * Set the Cache-Control header on an express `res` for `filePath`. Safe to
 * pass straight to `express.static({ setHeaders })` and to call before
 * `res.sendFile(index.html, { headers })`-style responses.
 */
export function applySpaHeaders(res, filePath) {
  res.setHeader("Cache-Control", spaCacheControlFor(filePath));
}
