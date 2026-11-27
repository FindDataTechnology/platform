// ── Same-name publish gate (add-mixed-fleet-packs-and-market-consolidation D5) ──
//
// The publish endpoint's publish-abuse extension: one author, one name. A
// publish (mint OR version-append) whose author already has a live pack —
// listed or unlisted, both count — under the exact same name is rejected
// with a structured 409 naming the existing pack and the upgrade path
// (publish a new version under that identifier). Nothing is stored: the gate
// runs as a pre-route on POST /api/packs, ahead of registerPackRoutes'
// handler, so a rejected request never reaches the registry write.
//
// Mounted by facet/index.js BEFORE registerPackRoutes — same modules,
// different process; the route stack order is what makes the pre-route win.
// Cross-author name collisions pass (curation matter, design D5); the
// authorEmail lookup is exact-match, no trim, no normalization (author
// identity must match exactly — standing platform lesson). A version-append
// to the colliding pack ITSELF is the sanctioned upgrade path and passes.
//
// Administrative cleanup of pre-existing same-name duplicates goes through
// the management face (unlist/retire) — never a publish-side exemption.

const MAX_PAGES = 100; // pageSize is registry-capped at 100; a hard stop guards a pathological loop.

// Author-scoped, exact-name lookup across everything the author owns
// (listed, unlisted, private — the author-self view widens both clauses).
export function findAuthorPackByName(registry, email, name) {
  const viewer = { email };
  for (let page = 1; page <= MAX_PAGES; page++) {
    const out = registry.list({ author: email, viewer, page, pageSize: 100 });
    const hit = (out.packs ?? []).find((p) => p.name === name);
    if (hit) return hit;
    if (out.page * out.pageSize >= out.total) return null;
  }
  return null;
}

export function registerSameNamePublishGate(app, { registry, resolveUser }) {
  app.post("/api/packs", (req, res, next) => {
    // Anonymous callers and body-less requests fall through: the publish
    // route owns those answers (401 with loginUrl, manifest validation).
    const user = resolveUser(req);
    if (!user) return next();
    const name = req.body?.manifest && typeof req.body.manifest.name === "string" ? req.body.manifest.name : null;
    if (!name) return next();
    const packId = typeof req.body?.packId === "string" ? req.body.packId : null;
    const existing = findAuthorPackByName(registry, user.email, name);
    // Versioning the colliding pack itself is the upgrade path, not a
    // duplicate — only a DIFFERENT registry entry under the same author and
    // name rejects.
    if (!existing || existing.id === packId) return next();
    return res.status(409).json({
      error: `同名包已存在：你名下已有名为「${name}」的 pack（listed 或 unlisted 均算）。请勿另发新包——在该包下发布新版本（POST /api/packs，body 带 packId: "${existing.id}"），或先经管理面 unlist 旧包后再发新包。`,
      code: "DUPLICATE_PACK_NAME",
      existingPackId: existing.id,
      hint: "upgrade path: publish a new version under the existing packId; to truly rename, unlist the old pack first (management face), then publish the new one",
    });
  });
}
