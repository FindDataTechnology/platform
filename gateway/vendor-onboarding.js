// ── Vendor server onboarding (openspec: add-vendor-supply-open / vendor-server-onboarding) ────
//
// The供方上牌闸: a vendor's own MCP server walks 准入审查 → 工具面 selfcheck
// → 平台代客写入 registry (register + toggle). The vendor never touches the
// registry (design D2/D5) — the whole lane runs on platform credentials, and
// every verdict lands in the onboarding row + audit trail, honestly classified
// (rejection always carries its axis; nothing is silently passed or swallowed).
//
// Two shapes ride the SAME pipeline (design D3):
//   vendor-hosted   the server runs on the vendor's own reach; the platform
//                   probes the declared endpoint and registers a proxy entry.
//   platform-hosted the platform runs the server; TODAY the write step still
//                   answers registry_write_failed (hosted execution env is a
//                   separate 运维 lane — the submission stays IN_REVIEW with a
//                   truthful note rather than faking in册).
import { randomBytes } from "node:crypto";
import { probeMcpToolNames } from "../lib/publish-tool-gate.js";
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";

const STATUSES = ["submitted", "in_review", "onboarded", "rejected", "withdrawn"];
const AXIS = {
  MATERIAL_INCOMPLETE: "material_incomplete",
  LICENSE_PROHIBITED: "license_prohibited",
  QUOTA_EXCEEDED: "quota_exceeded",
  DUPLICATE_NAME: "duplicate_name",
  SELFCHECK_FAILED: "selfcheck_failed",
  REGISTRY_WRITE_FAILED: "registry_write_failed",
  INVALID_KIND: "invalid_kind",
  PLATFORM_PENDING: "platform_hosted_pending",
};

// Prohibited-first license policy (curation review, license axis): AGPL/SSPL
// family for hosted, non-commercial terms, or no license at all. Empty license
// material is material_incomplete; a declared prohibited one is license_prohibited.
const LICENSE_BAN =
  /^(agpl|sspl|cc-by-nc|noncommercial|proprietary-none)/i;
const LICENSE_NEEDLE = (s) => String(s || "").trim();

// Tier policy (配额档): server count + publishes/hour are coarse knobs on the
// profile, overridable per tenant via VENDOR_TIER_QUOTAS JSON. publish rate
// rides the existing packs limiter; the server quota is enforced HERE because
// onboarding is where the anti-squat bound belongs (design D1 note).
const TIER_DEFAULTS = { free: { servers: 3, publishesPerHour: 10 }, pro: { servers: 50, publishesPerHour: 60 } };
export const tierQuotas = () => {
  // 缺陷回归（2026-10-28 真机）：空 env 经 "{}" 解析成功 → 返回空对象 → 桩内
  // quota=undefined 崩溃（`.servers`）。语义必须是「有配置才覆盖，缺省落到
  // 内置档，且内置档永远兜底 free」。
  let raw = null;
  try {
    raw = JSON.parse(process.env.VENDOR_TIER_QUOTAS || "null");
  } catch { /* 非法 JSON → 内置档 */ }
  const merged = { ...TIER_DEFAULTS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === "object") merged[k] = { ...(TIER_DEFAULTS[k] ?? {}), ...v };
    }
  }
  return merged;
};

// The registry write lane (design D2, user 10-27 ruling: registry 保持内部使用).
// The production write uses the console-cookie channel that already carries
// operator scripts (refresh-registry-tool-list.mjs); the fork's self-serve
// register API is the future replacement — swapping reach is a one-file change,
// never a pipeline change. Absent credentials degrade to registry_write_failed
// with a truthful note (the row stays in_review, resubmittable — design D5).
export function defaultWriter(env = process.env) {
  const url = (env.MARKET_REGISTRY_URL || env.REGISTRY_URL || "").replace(/\/+$/, "");
  // 通道一（目标车道）: fork vendor-lane 机器令牌通道 (fd-vendor-lane 分支,
  // 台账 §15.69 挂账1; Bearer service token)。通道二（兜底车道）: 控制台
  // cookie+CSRF（与 refresh-registry-tool-list 同一纪律）。env 切换:
  // REGISTRY_VENDOR_LANE=service-token → 走令牌通道; 其余=兜底 cookie。
  const laneToken = (env.VENDOR_LANE_TOKEN || "").trim();
  const laneMode = String(env.REGISTRY_VENDOR_LANE || "").trim() === "service-token";
  const cookie = env.REGISTRY_COOKIE || "";
  const csrf = env.REGISTRY_CSRF || "";
  const cookieConfigured = Boolean(url && cookie && csrf);
  const tokenConfigured = Boolean(url && laneToken);
  const configured = laneMode ? tokenConfigured : cookieConfigured;
  const makeHeaders = () =>
    laneMode
      ? { "Content-Type": "application/json", Authorization: `Bearer ${laneToken}` }
      : { "Content-Type": "application/json", "X-CSRF-Token": csrf, Cookie: cookie };
  return {
    configured,
    lane: laneMode ? "service-token" : "console-cookie",
    async write({ serverName, endpoint, surface, vendorSlug }) {
      if (!configured) {
        throw new Error(
          laneMode
            ? "registry write channel not configured (VENDOR_LANE_TOKEN / MARKET_REGISTRY_URL)"
            : "registry write channel not configured (REGISTRY_COOKIE/REGISTRY_CSRF)",
        );
      }
      const headers = makeHeaders();
      const entry = {
        name: serverName,
        path: `/${serverName}/`,
        proxy_pass_url: endpoint,
        description: `vendor:${vendorSlug} · ${surface.description || serverName}`,
        tags: ["vendor", vendorSlug],
        num_tools: surface.tools.length,
        metadata: {
          vendor: vendorSlug,
          surface: { commercial_tools: surface.commercialTools, surface_source: "vendor_onboarding" },
          credential_ref: surface.credentialRef ?? null,
        },
      };
      const regPath = laneMode ? "/api/vendor-servers/register" : "/api/servers/register";
      const togglePath = laneMode ? "/api/vendor-servers/toggle" : "/api/servers/toggle";
      for (const [method, path, body] of [
        ["POST", regPath, entry],
        ["POST", togglePath, { path: `/${serverName}/`, new_state: true }],
      ]) {
        // Outbound call discipline: platform-credential registry write rides
        // the shared deadline wrapper (default env bound).
        const r = await fetchWithTimeout(url + path, { method, headers, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`registry ${path} HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
      }
      return { path: `/${serverName}/` };
    },
  };
}

export function createOnboardingStore(db) {
  const now = () => Date.now();
  const mint = () => `ob_${randomBytes(9).toString("base64url")}`;

  const rowOut = (r) =>
    !r
      ? null
      : {
          id: r.id,
          vendorId: r.vendor_id,
          serverName: r.server_name,
          kind: r.kind,
          material: JSON.parse(r.material),
          status: r.status,
          axis: r.axis || null,
          note: r.note || null,
          createdBy: r.created_by,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };

  const audit = (vendorId, actor, action, detail = {}) =>
    db.prepare(`INSERT INTO vendor_audit (vendor_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(vendorId, actor, action, JSON.stringify(detail), now());

  return {
    rowOut,

    create({ vendorId, serverName, kind, material, actor }) {
      const id = mint();
      const t = now();
      db.prepare(
        `INSERT INTO vendor_onboarding (id, vendor_id, server_name, kind, material, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?)`,
      ).run(id, vendorId, serverName, kind, JSON.stringify(material ?? {}), actor, t, t);
      audit(vendorId, actor, "onboarding.submit", { id, serverName, kind });
      return rowOut(db.prepare(`SELECT * FROM vendor_onboarding WHERE id = ?`).get(id));
    },

    transition({ id, status, axis = null, note = null, actor }) {
      if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
      db.prepare(`UPDATE vendor_onboarding SET status = ?, axis = ?, note = ?, updated_at = ? WHERE id = ?`).run(
        status,
        axis ?? "",
        note ?? "",
        now(),
        id,
      );
      const row = db.prepare(`SELECT * FROM vendor_onboarding WHERE id = ?`).get(id);
      audit(row.vendor_id, actor, `onboarding.${status}`, { id, axis, note });
      return rowOut(row);
    },

    setMaterial({ id, material }) {
      db.prepare(`UPDATE vendor_onboarding SET material = ?, updated_at = ? WHERE id = ?`).run(
        JSON.stringify(material),
        now(),
        id,
      );
    },

    byId: (id) => rowOut(db.prepare(`SELECT * FROM vendor_onboarding WHERE id = ?`).get(id) ?? null),

    listForVendor(vendorId) {
      return db
        .prepare(`SELECT * FROM vendor_onboarding WHERE vendor_id = ? ORDER BY created_at DESC`)
        .all(vendorId)
        .map(rowOut);
    },

    // Duplicate-name axis: registry-name slot collision acros ALL vendors —
    // onboarded/in_review rows squat the slot; only the SAME vendor may retry
    // a withdrawn/rejected row (rewrites of your own reject are the fix path).
    nameTaken(serverName, { excludeVendorId = null } = {}) {
      return db
        .prepare(
          `SELECT o.id, o.vendor_id FROM vendor_onboarding o
           WHERE o.server_name = ? COLLATE NOCASE AND o.status IN ('submitted','in_review','onboarded')`,
        )
        .all(serverName)
        .filter((r) => r.vendor_id !== excludeVendorId);
    },

    // Quota consumption counts LIVE slots (submitted/in_review/onboarded);
    // excludeId removes the row under review itself (create-then-review would
    // otherwise count the submission against its own headroom).
    quotaUsed(vendorId, { excludeId = null } = {}) {
      return db
        .prepare(
          `SELECT COUNT(*) AS n FROM vendor_onboarding
           WHERE vendor_id = ? AND status IN ('submitted','in_review','onboarded') AND id != ?`,
        )
        .get(vendorId, String(excludeId ?? "")).n;
    },
  };
}

// ── The review pipeline (design D5 state machine) ────────────────────────────
// Every step returns either null (carry on) or a terminal {status, axis, note}
// — verdicts are DATA, so the route layer, the stored row, and the audit row
// can never disagree about WHY a submission ended where it did.
async function review({ store, vendor, row, deps }) {
  const { writer = defaultWriter(), existingNames: _existingNames = async () => new Map(), probe = probeMcpToolNames, tiers = tierQuotas(), log = console } = deps;
  const m = row.material ?? {};

  // 1. Material completeness: declaration-first — endpoint(s), surface.tools
  //    with input/output shapes, commercial set, domain metadata, license.
  const miss = [];
  if (typeof m.serverEndpoint !== "string" || !/^https?:\/\//.test(m.serverEndpoint)) miss.push("serverEndpoint");
  const surface = m.surface ?? {};
  if (!Array.isArray(surface.tools) || surface.tools.length === 0) miss.push("surface.tools");
  else if (surface.tools.some((t) => !t?.name)) miss.push("surface.tools[name]");
  if (!Array.isArray(surface.commercialTools)) miss.push("surface.commercialTools");
  if (!m.domain || typeof m.domain.name !== "string") miss.push("domain.name");
  if (miss.length) return { status: "rejected", axis: AXIS.MATERIAL_INCOMPLETE, note: `missing: ${miss.join(", ")}` };

  const license = LICENSE_NEEDLE(m.license);
  if (!license) return { status: "rejected", axis: AXIS.MATERIAL_INCOMPLETE, note: "missing: license" };
  if (LICENSE_BAN.test(license)) return { status: "rejected", axis: AXIS.LICENSE_PROHIBITED, note: license };

  // 2. Quota (配额过闸 in the需求书 vocabulary).
  const quota = tiers[vendor.quotaTier] ?? tiers.free ?? TIER_DEFAULTS.free;
  if (!quota || typeof quota.servers !== "number") {
    return { status: "rejected", axis: AXIS.QUOTA_EXCEEDED, note: `tier '${vendor.quotaTier}' has no usable quota config` };
  }
  const used = store.quotaUsed(row.vendorId, { excludeId: row.id });
  if (used >= quota.servers) {
    return { status: "rejected", axis: AXIS.QUOTA_EXCEEDED, note: `tier '${vendor.quotaTier}' servers ${used}/${quota.servers}` };
  }

  // 3. Duplicate registry name (all vendors share the registry namespace).
  if (store.nameTaken(row.serverName, { excludeVendorId: row.vendorId }).length > 0) {
    return { status: "rejected", axis: AXIS.DUPLICATE_NAME, note: "the registry-name slot is taken by another vendor" };
  }

  // 4. Selfcheck: probe the declared endpoint, compare declared-tools with the
  //    live tools/list, AND enforce commercial closure (设计: 闭包超集=商业集挡).
  if (row.kind === "vendor-hosted") {
    let live = null;
    let probed = null;
    // 独立预算 + 一次重试 (fleet 采样超时教训): vendor-hosted 外网抖动不该
    // 一击毙命 — 首轮失败即重探一次，双败才如实分类。
    for (let attempt = 0; attempt < 2 && live === null; attempt += 1) {
      try {
        live = await probe(m.serverEndpoint, { timeoutMs: 8000 });
      } catch (err) {
        log.warn?.(`[vendor-onboarding] selfcheck probe threw for '${row.serverName}' (attempt ${attempt + 1}): ${err?.message || err}`);
      }
    }
    if (live === null) return { status: "rejected", axis: AXIS.SELFCHECK_FAILED, note: "probe unreachable/timeout (2 attempts) — endpoint must answer an MCP tools/list from platform reach" };
    probed = new Set(live);
    const declared = new Set(surface.tools.map((t) => t.name));
    const missing = [...declared].filter((n) => !probed.has(n));
    if (missing.length) return { status: "rejected", axis: AXIS.SELFCHECK_FAILED, note: `declared tools not served: ${missing.join(", ")}` };
    const outsideCommercial = [...probed].filter((n) => !new Set(surface.commercialTools).has(n));
    if (outsideCommercial.length) {
      return { status: "rejected", axis: AXIS.SELFCHECK_FAILED, note: `live surface exceeds declared commercial set: ${outsideCommercial.join(", ")}` };
    }
  } else if (row.kind === "platform-hosted") {
    // Hosted execution environment is 运维 lane (deployment, egress posture);
    // the submission parks here TRUTHFULLY until that operand lands.
    return { status: "in_review", axis: AXIS.PLATFORM_PENDING, note: "platform-hosted execution env not yet available — submission held for operator lane" };
  } else {
    return { status: "rejected", axis: AXIS.INVALID_KIND, note: `kind must be vendor-hosted|platform-hosted, got '${row.kind}'` };
  }

  // 5. Platform代客写入 registry. writer unconfigured/unreachable = the row
  //    stays in_review (rejecting would lose a GOOD submission for a lane
  //    outage that is not the vendor's fault — design D5 挂起不伪造).
  try {
    const result = await writer.write({ serverName: row.serverName, endpoint: m.serverEndpoint, surface, vendorSlug: vendor.slug });
    return { status: "onboarded", axis: null, note: `registry path ${result.path}` };
  } catch (err) {
    log.warn?.(`[vendor-onboarding] registry write failed for '${row.serverName}': ${err?.message || err}`);
    return { status: "in_review", axis: AXIS.REGISTRY_WRITE_FAILED, note: String(err?.message || err).slice(0, 200) };
  }
}

export function registerOnboardingRoutes(app, { vendors, onboarding, resolveUser, rejectUnauthenticated, adminGroups = [], deps = {} }) {
  const isAdmin = (user) => adminGroups.some((g) => (user.groups || []).includes(g));
  const auth = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      rejectUnauthenticated(req, res);
      return null;
    }
    return user;
  };
  const bind = (user, slug) => {
    const profile = vendors.profileBySlug(slug);
    if (!profile) return { error: { status: 404, body: { error: "Vendor not found", code: "vendor-not-found" } } };
    if (isAdmin(user)) return { profile, admin: true };
    const role = vendors.memberRole(profile.id, user.email);
    if (!role) return { error: { status: 403, body: { error: "Vendor members only", code: "vendor-membership-required" } } };
    return { profile, role };
  };
  const eligible = (profile) => {
    const missing = [];
    if (!profile.displayName) missing.push("displayName");
    if (!profile.contact) missing.push("contact");
    return missing.length ? missing : null;
  };
  const runAndAnswer = async (res, { store, profile, row, actor }) => {
    const verdict = await review({ store, vendor: profile, row, deps });
    const next = onboarding.transition({ id: row.id, ...verdict, actor });
    const status = next.status === "rejected" ? 422 : next.status === "onboarded" ? 200 : 202;
    return res.status(status).json({ submission: next });
  };

  // Submit an onboarding application. Eligibility lives here (design: 能力闸),
  // the reviewer itself never asks who you are.
  app.post("/api/vendors/:slug/onboarding", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const b = bind(user, req.params.slug);
    if (b.error) return res.status(b.error.status).json(b.error.body);
    const miss = eligible(b.profile);
    if (miss) return res.status(403).json({ error: `Vendor profile incomplete (missing: ${miss.join(", ")})`, code: "vendor-profile-incomplete", fields: miss });
    const { serverName, kind = "vendor-hosted", material = {} } = req.body ?? {};
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(String(serverName ?? ""))) {
      return res.status(400).json({ error: "Invalid serverName", code: "missing-fields", fields: ["serverName"] });
    }
    const row = onboarding.create({ vendorId: b.profile.id, serverName, kind, material, actor: user.email });
    return runAndAnswer(res, { store: onboarding, profile: b.profile, row, actor: user.email });
  });

  // Operator resubmission of a held row (registry-write lane recovered) or the
  // admin override for a material revision the vendor cannot redo itself.
  app.post("/api/vendors/:slug/onboarding/:id/retry", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const b = bind(user, req.params.slug);
    if (b.error) return res.status(b.error.status).json(b.error.body);
    const row = onboarding.byId(req.params.id);
    if (!row || row.vendorId !== b.profile.id) return res.status(404).json({ error: "Submission not found", code: "submission-not-found" });
    if (row.status !== "in_review") {
      return res.status(409).json({ error: `Only in_review submissions can retry (current: ${row.status})`, code: "submission-not-retryable" });
    }
    // A material PATCH body rides the retry (the vendor fixes the failing axis).
    const body = req.body?.material;
    if (body && typeof body === "object") {
      onboarding.setMaterial({ id: row.id, material: { ...row.material, ...body } });
      row.material = { ...row.material, ...body };
    }
    return runAndAnswer(res, { store: onboarding, profile: b.profile, row, actor: user.email });
  });

  // Withdraw your own submission (member+ or admin).
  app.post("/api/vendors/:slug/onboarding/:id/withdraw", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const b = bind(user, req.params.slug);
    if (b.error) return res.status(b.error.status).json(b.error.body);
    const row = onboarding.byId(req.params.id);
    if (!row || row.vendorId !== b.profile.id) return res.status(404).json({ error: "Submission not found", code: "submission-not-found" });
    if (["onboarded", "rejected", "withdrawn"].includes(row.status)) {
      return res.status(409).json({ error: `Cannot withdraw a ${row.status} submission`, code: "submission-not-withdrawable" });
    }
    res.json({ submission: onboarding.transition({ id: row.id, status: "withdrawn", actor: user.email }) });
  });

  // The vendor-side read face: your own submissions, honestly再生 from rows.
  app.get("/api/vendors/:slug/onboarding", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const b = bind(user, req.params.slug);
    if (b.error) return res.status(b.error.status).json(b.error.body);
    res.json({ submissions: onboarding.listForVendor(b.profile.id) });
  });

  app.get("/api/vendors/:slug/onboarding/:id", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const b = bind(user, req.params.slug);
    if (b.error) return res.status(b.error.status).json(b.error.body);
    const row = onboarding.byId(req.params.id);
    if (!row || row.vendorId !== b.profile.id) return res.status(404).json({ error: "Submission not found", code: "submission-not-found" });
    res.json({ submission: row });
  });

  // 台账/台账对账 anchors are external (docs/registry-maintenance.md tasks 4.2);
  // the ops retry uses the SAME member surface — the lane never differs.
}

export { AXIS as ONBOARDING_AXIS, STATUSES as ONBOARDING_STATUSES };
