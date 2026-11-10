// ── Vendor identity (openspec: add-vendor-supply-open / vendor-identity) ─────
//
// The marketplace-plane vendor主体: anyone signed in may register a supplier
// 主体 (no human pre-review — the onboarding gate and the publish gates are
// the review), binding accounts ride the SAME db as the pack registry (both
// must outlive and cross cells). Two information lanes per design D1:
//   capability   — "may I do this" (publish eligibility, onboarding submit):
//                  an ACTIVE BINDING to a COMPLETE profile;
//   attribution  — "whose is this" (market署名, earnings归属骨架): profile rows.
// Neither substitutes for the other, and neither reaches for Logto at
// request time — group sync is a display concern, not a runtime dependency.
//
// The audit lane (vendor_audit) records every mutation with actor/fields —
// vendor-side material is third-party by definition, "who changed what when"
// is the accountability floor.

import { randomBytes } from "node:crypto";

// 主体名 charset: registry-path-friendly, case-insensitive unique.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

// Mandatory profile fields (registration AND publish-time completeness gate —
// a profile edited behind the gate loses eligibility until complete again).
const profileMissingFields = (r) =>
  [
    ["slug", r?.slug],
    ["displayName", r?.display_name],
    ["contact", r?.contact],
  ]
    .filter(([, v]) => !(typeof v === "string" && v.trim()))
    .map(([k]) => k);

export function installVendorTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS vendor_profiles (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    contact TEXT NOT NULL DEFAULT '',
    quota_tier TEXT NOT NULL DEFAULT 'default',
    payout_ref TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS vendor_profiles_slug_ci ON vendor_profiles(slug COLLATE NOCASE)`);
  db.exec(`CREATE TABLE IF NOT EXISTS vendor_members (
    vendor_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vendor_id, email)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS vendor_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS vendor_audit_vendor ON vendor_audit(vendor_id, id)`);
  // Onboarding rows live beside identity (vendor-server-onboarding): one
  // installer keeps the vendor namespace's schema in a single migration surface.
  db.exec(`CREATE TABLE IF NOT EXISTS vendor_onboarding (
    id TEXT PRIMARY KEY,
    vendor_id TEXT NOT NULL,
    server_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    material TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    axis TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS vendor_onboarding_vendor ON vendor_onboarding(vendor_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS vendor_onboarding_name ON vendor_onboarding(server_name)`);
}

export function createVendorStore(db) {
  const now = () => Date.now();
  const mintId = (p) => `${p}_${randomBytes(9).toString("base64url")}`;

  const rowOut = (r, { role } = {}) =>
    !r
      ? null
      : {
          id: r.id,
          slug: r.slug,
          displayName: r.display_name,
          contact: r.contact,
          quotaTier: r.quota_tier,
          payoutRef: r.payout_ref,
          createdBy: r.created_by,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          ...(role ? { role } : {}),
        };

  const audit = (vendorId, actor, action, detail = {}) =>
    db.prepare(`INSERT INTO vendor_audit (vendor_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      vendorId,
      actor,
      action,
      JSON.stringify(detail),
      now(),
    );

  const profileBySlug = (slug) =>
    db.prepare(`SELECT * FROM vendor_profiles WHERE slug = ? COLLATE NOCASE`).get(String(slug ?? "")) ?? null;
  const profileById = (id) => db.prepare(`SELECT * FROM vendor_profiles WHERE id = ?`).get(String(id ?? "")) ?? null;

  return {
    profileBySlug: (slug) => rowOut(profileBySlug(slug)),
    profileById: (id) => rowOut(profileById(id)),

    // 公开署名 is the ONLY field the marketplace projection may quote —
    // contact/payout stay member-visible (routes never project them outward).
    attributionName: (slug) => profileBySlug(slug)?.display_name ?? null,

    createProfile({ slug, displayName, contact = "", payoutRef = "", actor }) {
      const fields = profileMissingFields({ slug, display_name: displayName, contact });
      if (fields.length) return { error: "missing-fields", fields };
      if (!SLUG_RE.test(slug)) return { error: "invalid-slug", fields: ["slug"] };
      if (profileBySlug(slug)) return { error: "vendor-name-conflict" };
      const id = mintId("v");
      const t = now();
      db.prepare(
        `INSERT INTO vendor_profiles (id, slug, display_name, contact, payout_ref, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, slug, displayName, contact, payoutRef, actor, t, t);
      db.prepare(`INSERT INTO vendor_members (vendor_id, email, role, created_at) VALUES (?, ?, 'owner', ?)`).run(id, actor, t);
      audit(id, actor, "profile.create", { slug });
      return { vendor: rowOut(profileById(id)) };
    },

    updateProfile({ id, patch = {}, actor, admin = false }) {
      const row = profileById(id);
      if (!row) return { error: "vendor-not-found" };
      const changed = {};
      if (typeof patch.displayName === "string" && patch.displayName.trim()) {
        if (patch.displayName !== row.display_name) changed.display_name = patch.displayName;
      }
      if (typeof patch.contact === "string" && patch.contact !== row.contact) changed.contact = patch.contact;
      if (typeof patch.payoutRef === "string" && patch.payoutRef !== row.payout_ref) changed.payout_ref = patch.payoutRef;
      // quota tier is a platform lever, not a self-serve field.
      if (admin === true && typeof patch.quotaTier === "string" && patch.quotaTier !== row.quota_tier) {
        changed.quota_tier = patch.quotaTier;
      }
      if (Object.keys(changed).length === 0) return { vendor: rowOut(row), changed: [] };
      const sets = Object.keys(changed).map((k) => `${k} = ?`);
      db.prepare(`UPDATE vendor_profiles SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(
        ...Object.values(changed),
        now(),
        id,
      );
      audit(id, actor, "profile.update", {
        fields: Object.fromEntries(Object.keys(changed).map((k) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), changed[k]])),
      });
      return { vendor: rowOut(profileById(id)), changed: Object.keys(changed) };
    },

    memberRole(vendorId, email) {
      const r = db.prepare(`SELECT role FROM vendor_members WHERE vendor_id = ? AND email = ?`).get(vendorId, String(email ?? ""));
      return r?.role ?? null;
    },

    bindingsFor(email) {
      return db
        .prepare(
          `SELECT p.*, m.role AS m_role FROM vendor_members m JOIN vendor_profiles p ON p.id = m.vendor_id
           WHERE m.email = ? ORDER BY p.created_at`,
        )
        .all(String(email ?? ""))
        .map((r) => rowOut(r, { role: r.m_role }));
    },

    // Publish/onboarding eligibility (capability lane): an active binding to a
    // COMPLETE profile. Incomplete profiles stay bound but ineligible.
    eligibleVendor(email) {
      for (const b of db.prepare(
        `SELECT p.* FROM vendor_members m JOIN vendor_profiles p ON p.id = m.vendor_id WHERE m.email = ? ORDER BY p.created_at`,
      ).all(String(email ?? ""))) {
        if (profileMissingFields(b).length === 0) return rowOut(b);
      }
      return null;
    },

    // Publish-attribution resolution (pack-marketplace delta): the declared
    // vendor must exist, the caller must be BOUND to it, and its profile must
    // be complete. One seam so publish and any future writer agree verbatim.
    attributionFor(user, input) {
      const row = profileBySlug(input) ?? profileById(input);
      if (!row) return { error: true, status: 404, body: { error: "Vendor not found", code: "vendor-not-found" } };
      if (!this.memberRole(row.id, user.email)) {
        return {
          error: true,
          status: 403,
          body: { error: `Not bound to vendor '${row.slug}' — attribution requires an active binding`, code: "vendor-binding-required" },
        };
      }
      const missing = profileMissingFields(row);
      if (missing.length > 0) {
        return {
          error: true,
          status: 403,
          body: { error: `Vendor profile incomplete (missing: ${missing.join(", ")})`, code: "vendor-profile-incomplete", fields: missing },
        };
      }
      return { slug: row.slug };
    },

    addMember({ vendorId, email, role = "member", actor }) {
      if (!profileById(vendorId)) return { error: "vendor-not-found" };
      if (!/^\S+@\S+$/.test(String(email ?? ""))) return { error: "missing-fields", fields: ["email"] };
      const r = role === "owner" ? "owner" : "member";
      db.prepare(
        `INSERT INTO vendor_members (vendor_id, email, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (vendor_id, email) DO UPDATE SET role = excluded.role`,
      ).run(vendorId, email, r, now());
      audit(vendorId, actor, "member.add", { email, role: r });
      return { ok: true };
    },

    removeMember({ vendorId, email, actor }) {
      const owners = db.prepare(`SELECT COUNT(*) AS n FROM vendor_members WHERE vendor_id = ? AND role = 'owner'`).get(vendorId).n;
      const target = db.prepare(`SELECT role FROM vendor_members WHERE vendor_id = ? AND email = ?`).get(vendorId, String(email ?? ""));
      if (!target) return { ok: true };
      // The last owner may not be removed — the主体 would become unmanageable.
      if (target.role === "owner" && owners <= 1) return { error: "last-owner" };
      db.prepare(`DELETE FROM vendor_members WHERE vendor_id = ? AND email = ?`).run(vendorId, email);
      audit(vendorId, actor, "member.remove", { email });
      return { ok: true };
    },

    audit(vendorId, { limit = 100 } = {}) {
      return db
        .prepare(`SELECT id, actor, action, detail, created_at AS createdAt FROM vendor_audit WHERE vendor_id = ? ORDER BY id DESC LIMIT ?`)
        .all(vendorId, Math.min(Math.max(1, Number(limit) || 100), 500))
        .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
    },
  };
}

export function registerVendorRoutes(app, { vendors, resolveUser, rejectUnauthenticated, adminGroups = [] }) {
  const isAdmin = (user) => adminGroups.some((g) => (user.groups || []).includes(g));
  const auth = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      rejectUnauthenticated(req, res);
      return null;
    }
    return user;
  };
  // Member-or-admin read lane: profile contact/audit never leak to non-members.
  const memberOrAdmin = (user, slug) => {
    const row = vendors.profileBySlug(slug);
    if (!row) return { error: 404 };
    if (isAdmin(user)) return { row };
    const role = vendors.memberRole(row.id, user.email);
    return role ? { row, role } : { error: 403 };
  };

  // 注册即得 (design D1): no human pre-review; capability gates live downstream.
  app.post("/api/vendors", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const body = req.body ?? {};
    const result = vendors.createProfile({
      slug: String(body.slug ?? ""),
      displayName: String(body.displayName ?? ""),
      contact: String(body.contact ?? ""),
      payoutRef: String(body.payoutRef ?? ""),
      actor: user.email,
    });
    if (result.error === "vendor-name-conflict") {
      return res.status(409).json({ error: `Vendor name '${body.slug}' is already taken`, code: "vendor-name-conflict" });
    }
    if (result.error === "missing-fields" || result.error === "invalid-slug") {
      return res.status(400).json({ error: `Invalid registration (missing/invalid: ${result.fields.join(", ")})`, code: result.error, fields: result.fields });
    }
    res.status(201).json({ vendor: result.vendor });
  });

  app.get("/api/vendors/mine", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    res.json({ vendors: vendors.bindingsFor(user.email) });
  });

  app.get("/api/vendors/:slug", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const m = memberOrAdmin(user, req.params.slug);
    if (m.error === 404) return res.status(404).json({ error: "Vendor not found", code: "vendor-not-found" });
    if (m.error === 403) return res.status(403).json({ error: "Vendor members only", code: "vendor-membership-required" });
    res.json({ vendor: m.row, role: m.role ?? "admin" });
  });

  app.patch("/api/vendors/:slug", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const m = memberOrAdmin(user, req.params.slug);
    if (m.error === 404) return res.status(404).json({ error: "Vendor not found", code: "vendor-not-found" });
    if (m.error === 403 || (m.role !== "owner" && !isAdmin(user))) {
      return res.status(403).json({ error: "Vendor owner required", code: "vendor-owner-required" });
    }
    const result = vendors.updateProfile({ id: m.row.id, patch: req.body ?? {}, actor: user.email, admin: isAdmin(user) });
    if (result.error) return res.status(404).json({ error: "Vendor not found", code: "vendor-not-found" });
    res.json({ vendor: result.vendor, changed: result.changed });
  });

  app.post("/api/vendors/:slug/members", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const m = memberOrAdmin(user, req.params.slug);
    if (m.error === 404) return res.status(404).json({ error: "Vendor not found", code: "vendor-not-found" });
    if (m.error === 403 || (m.role !== "owner" && !isAdmin(user))) {
      return res.status(403).json({ error: "Vendor owner required", code: "vendor-owner-required" });
    }
    const body = req.body ?? {};
    const result = vendors.addMember({ vendorId: m.row.id, email: body.email, role: body.role, actor: user.email });
    if (result.error === "missing-fields") return res.status(400).json({ error: "Invalid member (missing/invalid: email)", code: "missing-fields", fields: ["email"] });
    res.json({ ok: true });
  });

  app.delete("/api/vendors/:slug/members/:email", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const m = memberOrAdmin(user, req.params.slug);
    if (m.error === 404) return res.status(404).json({ error: "Vendor not found", code: "vendor-not-found" });
    if (m.error === 403 || (m.role !== "owner" && !isAdmin(user))) {
      return res.status(403).json({ error: "Vendor owner required", code: "vendor-owner-required" });
    }
    const result = vendors.removeMember({ vendorId: m.row.id, email: req.params.email, actor: user.email });
    if (result.error === "last-owner") return res.status(400).json({ error: "The last owner cannot be removed", code: "last-owner" });
    res.json({ ok: true });
  });

  app.get("/api/vendors/:slug/audit", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const m = memberOrAdmin(user, req.params.slug);
    if (m.error === 404) return res.status(404).json({ error: "Vendor not found", code: "vendor-not-found" });
    if (m.error === 403) return res.status(403).json({ error: "Vendor members only", code: "vendor-membership-required" });
    res.json({ audit: vendors.audit(m.row.id, { limit: req.query.limit }) });
  });
}
