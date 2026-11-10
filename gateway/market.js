// ── Market revenue share (openspec: add-market-revenue-share) ────────────────
//
// 「上架物被买走」的账：append-only 成交记 + sub2api 余额内账结算 + 平台抽成
// + 供应商收益投影。账本纪律两条（design D1/D2）：
//   * 一切汇总都是 PROJECTION —— 从成交记现算，不落计数器（fleet_runs 先例），
//     拒付靠反向行，原行永不可改可删；
//   * 幂等两键 —— 购买键 = buyer|pack|version(|period window)，结算键 = 成交行 id；
//     重放安全：pending→settle→失败挂账，读面永不伪造已结算。
//
// v1 闭环抵扣：vendor 主体的已结收益可被其绑定成员在购买时抵扣
// （credit_vendor_slug 单池归属——design D2 折中，粗粒度按用户裁决）；
// 分成只认成交记，调用量计费链（sub2api 边界结算）与本账本零交集。

import { randomBytes } from "node:crypto";
import { createSub2apiClient } from "../lib/sub2api-admin.js";

// 平台抽成（ADR-0022 默认档 30%）：快照进成交行，改档只影响其后成交。
const shareRateDefault = () => {
  const v = Number(process.env.MARKET_SHARE_RATE);
  return Number.isFinite(v) && v >= 0 && v < 1 ? v : 0.3;
};

export function installMarketTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS market_purchases (
    id TEXT PRIMARY KEY,
    buyer_email TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    period_days INTEGER,
    price_usd REAL NOT NULL,
    share_rate REAL NOT NULL,
    vendor_slug TEXT NOT NULL DEFAULT '',
    vendor_earned_usd REAL NOT NULL DEFAULT 0,
    platform_earned_usd REAL NOT NULL DEFAULT 0,
    charge_usd REAL NOT NULL,
    credit_usd REAL NOT NULL DEFAULT 0,
    credit_vendor_slug TEXT NOT NULL DEFAULT '',
    direction TEXT NOT NULL DEFAULT 'purchase',
    ref_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    idem_key TEXT NOT NULL UNIQUE,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS market_purchases_buyer ON market_purchases(buyer_email, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS market_purchases_pack ON market_purchases(pack_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS market_purchases_vendor ON market_purchases(vendor_slug) WHERE vendor_slug != ''`);
}

export function createMarketStore(db) {
  const now = () => Date.now();
  const mint = () => `mp_${randomBytes(9).toString("base64url")}`;
  const DAY = 86_400_000;

  const rowOut = (r) =>
    !r
      ? null
      : {
          id: r.id,
          buyerEmail: r.buyer_email,
          packId: r.pack_id,
          version: r.version,
          kind: r.kind,
          periodDays: r.period_days,
          priceUsd: r.price_usd,
          shareRate: r.share_rate,
          vendorSlug: r.vendor_slug || null,
          vendorEarnedUsd: r.vendor_earned_usd,
          platformEarnedUsd: r.platform_earned_usd,
          chargeUsd: r.charge_usd,
          creditUsd: r.credit_usd,
          creditVendorSlug: r.credit_vendor_slug || null,
          direction: r.direction,
          refId: r.ref_id || null,
          status: r.status,
          note: r.note || null,
          createdAt: r.created_at,
          settledAt: r.settled_at,
        };

  const byIdem = (key) => db.prepare(`SELECT * FROM market_purchases WHERE idem_key = ?`).get(String(key)) ?? null;
  const byId = (id) => db.prepare(`SELECT * FROM market_purchases WHERE id = ?`).get(String(id)) ?? null;

  const insert = (row) => {
    db.prepare(
      `INSERT INTO market_purchases
        (id, buyer_email, pack_id, version, kind, period_days, price_usd, share_rate,
         vendor_slug, vendor_earned_usd, platform_earned_usd, charge_usd, credit_usd, credit_vendor_slug,
         direction, ref_id, status, idem_key, note, created_at)
       VALUES (@id, @buyer, @pack, @version, @kind, @periodDays, @price, @shareRate,
               @vendorSlug, @vendorEarned, @platformEarned, @charge, @credit, @creditVendorSlug,
               @direction, @refId, @status, @idemKey, @note, @createdAt)`,
    ).run({
      id: row.id ?? mint(),
      buyer: row.buyer,
      pack: row.packId,
      version: row.version,
      kind: row.kind,
      periodDays: row.periodDays ?? null,
      price: row.price,
      shareRate: row.shareRate,
      vendorSlug: row.vendorSlug ?? "",
      vendorEarned: row.vendorEarned,
      platformEarned: row.platformEarned,
      charge: row.charge,
      credit: row.credit,
      creditVendorSlug: row.creditVendorSlug ?? "",
      direction: row.direction ?? "purchase",
      refId: row.refId ?? "",
      status: row.status,
      idemKey: row.idemKey,
      note: row.note ?? "",
      createdAt: row.createdAt ?? now(),
    });
    return rowOut(byIdem(row.idemKey));
  };

  const refunded = (purchaseId) =>
    Boolean(
      db.prepare(`SELECT 1 FROM market_purchases WHERE direction = 'refund' AND ref_id = ? AND status = 'settled' LIMIT 1`).get(purchaseId),
    );

  return {
    rowOut,
    byIdem: (key) => rowOut(byIdem(key)),
    byId: (id) => rowOut(byId(id)),
    insert,

    markSettled(id) {
      db.prepare(`UPDATE market_purchases SET status = 'settled', settled_at = ? WHERE id = ?`).run(now(), id);
      return rowOut(byId(id));
    },
    markFailed(id, note) {
      db.prepare(`UPDATE market_purchases SET status = 'failed', note = ? WHERE id = ?`).run(String(note ?? "").slice(0, 300), id);
      return rowOut(byId(id));
    },

    // 活动权益（projection）：once=永续；period=期窗内；被已结退款的一律失效。
    activeEntitlement(buyerEmail, packId) {
      const t = now();
      const rows = db
        .prepare(
          `SELECT * FROM market_purchases WHERE buyer_email = ? AND pack_id = ?
           AND direction = 'purchase' AND status = 'settled' ORDER BY created_at DESC`,
        )
        .all(String(buyerEmail), String(packId));
      for (const r of rows) {
        if (refunded(r.id)) continue;
        if (r.kind === "once") return rowOut(r);
        if (r.kind === "period" && r.created_at + (r.period_days ?? 0) * DAY > t) return rowOut(r);
      }
      return null;
    },

    purchasesForBuyer(email, { limit = 100 } = {}) {
      return db
        .prepare(`SELECT * FROM market_purchases WHERE buyer_email = ? ORDER BY created_at DESC LIMIT ?`)
        .all(String(email), Math.min(500, Math.max(1, Number(limit) || 100)))
        .map(rowOut);
    },

    purchasesForVendor(slug, { limit = 200 } = {}) {
      return db
        .prepare(`SELECT * FROM market_purchases WHERE vendor_slug = ? ORDER BY created_at DESC LIMIT ?`)
        .all(String(slug), Math.min(1000, Math.max(1, Number(limit) || 200)))
        .map(rowOut);
    },

    // 供应商收益投影（projection，可重算）：
    //   settledUsd = Σ已结分成(购) − Σ已结分成(退)；credit 池 = settledUsd − 成员已实耗抵扣。
    vendorEarnings(slug) {
      const earned =
        db
          .prepare(
            `SELECT COALESCE(SUM(vendor_earned_usd), 0) AS n FROM market_purchases
             WHERE vendor_slug = ? AND direction = 'purchase' AND status = 'settled'`,
          )
          .get(slug).n -
        db
          .prepare(
            `SELECT COALESCE(SUM(vendor_earned_usd), 0) AS n FROM market_purchases
             WHERE vendor_slug = ? AND direction = 'refund' AND status = 'settled'`,
          )
          .get(slug).n;
      const pending = db
        .prepare(
          `SELECT COALESCE(SUM(vendor_earned_usd), 0) AS n FROM market_purchases
           WHERE vendor_slug = ? AND direction = 'purchase' AND status IN ('pending','failed')`,
        )
        .get(slug).n;
      const creditSpent =
        db
          .prepare(
            `SELECT COALESCE(SUM(credit_usd), 0) AS n FROM market_purchases
             WHERE credit_vendor_slug = ? AND direction = 'purchase' AND status = 'settled'`,
          )
          .get(slug).n -
        db
          .prepare(
            `SELECT COALESCE(SUM(credit_usd), 0) AS n FROM market_purchases
             WHERE credit_vendor_slug = ? AND direction = 'refund' AND status = 'settled'`,
          )
          .get(slug).n;
      return {
        settledUsd: Math.round(earned * 100) / 100,
        pendingUsd: Math.round(pending * 100) / 100,
        creditSpentUsd: Math.round(creditSpent * 100) / 100,
        availableCreditUsd: Math.round((earned - creditSpent) * 100) / 100,
      };
    },
  };
}

// ── 价格声明解析（发布侧，版本级商业元数据 —— manifest 不承载，D4）───────────
// null 输入 = 免费条目（默认，行为与无定价能力时逐字节一致）。
export function parsePricing(input) {
  if (input == null) return { pricing: null };
  const priceUsd = Number(input.priceUsd);
  const kind = input.kind === "period" ? "period" : "once";
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { error: "priceUsd must be a positive number" };
  let periodDays = null;
  if (kind === "period") {
    periodDays = Number(input.periodDays);
    if (!Number.isInteger(periodDays) || periodDays <= 0) return { error: "period pricing requires a positive integer periodDays" };
  }
  return { pricing: { priceUsd: Math.round(priceUsd * 100) / 100, kind, periodDays } };
}

// ── Routes ───────────────────────────────────────────────────────────────────
export function registerMarketRoutes(app, {
  registry,
  vendors,
  market,
  resolveUser,
  rejectUnauthenticated,
  adminGroups = [],
  deps = {},
}) {
  const isAdmin = (user) => adminGroups.some((g) => (user.groups || []).includes(g));
  const auth = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      rejectUnauthenticated(req, res);
      return null;
    }
    return user;
  };
  const sub2api = () => deps.sub2api ?? createSub2apiClient();
  const shareRate = deps.shareRate ?? shareRateDefault();
  const round2 = (n) => Math.round(n * 100) / 100;

  // 买家抵扣池：跨绑定 vendor 取可用最大的一池（单池归属，design D2 折中）。
  const bestCreditPool = (email) => {
    let best = null;
    for (const b of vendors?.bindingsFor(email) ?? []) {
      const e = market.vendorEarnings(b.slug);
      if (e.availableCreditUsd > 0 && (!best || e.availableCreditUsd > best.available)) {
        best = { slug: b.slug, available: e.availableCreditUsd };
      }
    }
    return best;
  };

  const splitFor = (price, vendorSlug) => {
    if (!vendorSlug) return { vendorEarned: 0, platformEarned: price };
    const platform = round2(price * shareRate);
    return { vendorEarned: round2(price - platform), platformEarned: platform };
  };

  // 结算执行（pending/failed → settled）：幂等键=成交行 id，失败挂账如实。
  const attemptSettle = async (row) => {
    try {
      if (row.chargeUsd > 0) {
        const account = registry.billingAccount(row.buyerEmail);
        if (!account) throw new Error("billing account not resolved for buyer");
        await sub2api().adjustBalance({
          userId: account.user_id,
          amountUsd: row.chargeUsd,
          operation: "subtract",
          idempotencyKey: `mkt_${row.id}`,
        });
      }
      return { settled: market.markSettled(row.id) };
    } catch (err) {
      return { failed: market.markFailed(row.id, `settlement failed: ${err?.message || err}`) };
    }
  };

  // 购买（幂等）：已有活动权益=原行返回；同 idem 重放=原行/重试结算。
  app.post("/api/packs/:id/purchase", async (req, res) => {
    const user = auth(req, res);
    if (!user || !user.email) return;
    const pack = registry.get(req.params.id, { includeUnlisted: false });
    if (!pack || !registry.visibleTo({ visibility: pack.visibility, author_email: pack.authorEmail }, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    const pricing = pack.pricing ?? null;
    if (!pricing || !(pricing.priceUsd > 0)) {
      return res.status(400).json({ error: "This pack is free — no purchase required", code: "not-for-sale" });
    }
    const entitled = market.activeEntitlement(user.email, pack.id);
    if (entitled) return res.json({ purchase: entitled, note: "already-entitled" });

    const window =
      pricing.kind === "period" ? `|${Math.floor(Date.now() / (pricing.periodDays * 86_400_000))}` : "";
    const idemKey = `${user.email}|${pack.id}|${pack.version}${window}`;
    let row = market.byIdem(idemKey);
    if (row?.status === "settled") return res.json({ purchase: row, note: "idempotent-replay" });
    if (row && (row.status === "pending" || row.status === "failed")) {
      const r = await attemptSettle(row);
      return r.settled
        ? res.json({ purchase: r.settled })
        : res.status(502).json({ error: "Purchase could not be settled — held for retry", code: "settlement-failed", purchase: r.failed });
    }

    // 抵扣池（useCredit !== false 时自动启用）。
    const useCredit = req.body?.useCredit !== false;
    const pool = useCredit ? bestCreditPool(user.email) : null;
    const credit = pool ? Math.min(pool.available, pricing.priceUsd) : 0;
    const charge = round2(pricing.priceUsd - credit);

    // 差额校验在写行之前（余额不足如实拒 + 差额，不落成交行）。
    const account = registry.billingAccount(user.email);
    if (charge > 0) {
      if (!account) return res.status(402).json({ error: "Buyer has no linked sub2api billing account", code: "billing-account-required" });
      let balance = null;
      try {
        balance = (await sub2api().readUser(account.user_id)).balance;
      } catch (err) {
        return res.status(502).json({ error: `Balance check unavailable (${err?.message || err}) — nothing was charged`, code: "billing-unavailable" });
      }
      if (balance < charge) {
        return res.status(402).json({
          error: `Insufficient balance ($${balance.toFixed(2)} < $${charge.toFixed(2)})`,
          code: "insufficient-balance",
          shortfallUsd: round2(charge - balance),
        });
      }
    }

    const { vendorEarned, platformEarned } = splitFor(pricing.priceUsd, pack.vendor?.slug ?? "");
    row = market.insert({
      buyer: user.email,
      packId: pack.id,
      version: pack.version,
      kind: pricing.kind,
      periodDays: pricing.periodDays,
      price: pricing.priceUsd,
      shareRate,
      vendorSlug: pack.vendor?.slug ?? "",
      vendorEarned,
      platformEarned,
      charge,
      credit,
      creditVendorSlug: credit > 0 ? pool.slug : "",
      status: "pending",
      idemKey,
    });
    const r = await attemptSettle(row);
    return r.settled
      ? res.status(201).json({ purchase: r.settled })
      : res.status(502).json({ error: "Purchase could not be settled — held for retry", code: "settlement-failed", purchase: r.failed });
  });

  // 买家读面：自己的成交与当前权益（收益同源 projection 的另一侧）。
  app.get("/api/market/purchases/mine", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    res.json({
      purchases: market.purchasesForBuyer(user.email),
      creditPools: (vendors?.bindingsFor(user.email) ?? []).map((b) => ({ slug: b.slug, ...market.vendorEarnings(b.slug) })),
    });
  });

  // 装前闸的读值：购买状态（详情路由也有 purchased 投影——两处同store）。
  app.get("/api/packs/:id/purchase-status", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    res.json({ entitled: Boolean(market.activeEntitlement(user.email, req.params.id)) });
  });

  // 供应商收益账：成员/admin 可读，数字全部可重算。
  app.get("/api/vendors/:slug/earnings", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const profile = vendors?.profileBySlug(req.params.slug);
    if (!profile) return res.status(404).json({ error: "Vendor not found", code: "vendor-not-found" });
    if (!isAdmin(user) && !vendors.memberRole(profile.id, user.email)) {
      return res.status(403).json({ error: "Vendor members only", code: "vendor-membership-required" });
    }
    res.json({
      earnings: market.vendorEarnings(profile.slug),
      purchases: market.purchasesForVendor(profile.slug).filter((p) => p.direction === "purchase"),
    });
  });

  // 反向行（拒付/裁定退款，admin）：原行不可改，refund 行幂等，余额回补同幂等键。
  app.post("/api/ops/market-purchases/:id/refund", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    if (!isAdmin(user)) return res.status(403).json({ error: "Admin required" });
    const original = market.byId(req.params.id);
    if (!original || original.direction !== "purchase") return res.status(404).json({ error: "Purchase not found" });
    if (original.status !== "settled") return res.status(409).json({ error: `Only settled purchases can be refunded (current: ${original.status})`, code: "not-refundable" });
    const idemKey = `refund|${original.id}`;
    const existing = market.byIdem(idemKey);
    if (existing?.status === "settled") return res.json({ refund: existing, note: "idempotent-replay" });
    const refund = existing
      ? existing
      : market.insert({
          buyer: original.buyerEmail,
          packId: original.packId,
          version: original.version,
          kind: original.kind,
          periodDays: original.periodDays,
          price: original.priceUsd,
          shareRate: original.shareRate,
          vendorSlug: original.vendorSlug ?? "",
          vendorEarned: original.vendorEarnedUsd,
          platformEarned: original.platformEarnedUsd,
          charge: original.chargeUsd,
          credit: original.creditUsd,
          creditVendorSlug: original.creditVendorSlug ?? "",
          direction: "refund",
          refId: original.id,
          status: "pending",
          idemKey,
          note: typeof req.body?.note === "string" ? req.body.note.slice(0, 200) : "",
        });
    // 回补只含现金部分；抵扣部分随 refund 行的投影自然回池，无需转账。
    if (refund.chargeUsd > 0) {
      try {
        const account = registry.billingAccount(original.buyerEmail);
        if (!account) throw new Error("billing account not resolved for buyer");
        await sub2api().adjustBalance({
          userId: account.user_id,
          amountUsd: refund.chargeUsd,
          operation: "add",
          idempotencyKey: `mkt_ref_${refund.id}`,
        });
      } catch (err) {
        return res.status(502).json({
          error: `Refund settlement failed (${err?.message || err}) — held for retry`,
          code: "settlement-failed",
          refund: market.markFailed(refund.id, `refund settlement failed: ${err?.message || err}`),
        });
      }
    }
    res.status(201).json({ refund: market.markSettled(refund.id) });
  });
}
