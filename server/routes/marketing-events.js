// 营销转化埋点（openspec: close-marketing-funnel / marketing-lead-capture
// 「转化埋点是最小闭集且必须能证明自己在跑」）。
//
// 两个端点：
//   POST /api/marketing/collect         接收 page_view / cta_click（闭集外一律拒收）
//                                      匿名可达——访客浏览器没有会话
//   GET  /api/marketing/events/summary  内部读数面（走会话门，不匿名）
//
// 三条硬约束：
//   ① 事件名闭集：只接受 page_view / cta_click。闭集外的名字被拒收且记录原因，
//      不入库——静默丢弃会让「配置写错」看起来像「没人来」。
//   ② 「未采集」≠「零转化」：端点未配置（MARKETING_EVENTS_ENABLED=off）或库不可用时，
//      summary 返回 collected:false + 原因，MUST NOT 返回 0 —— 0 是一个事实断言，
//      而这里是「我们不知道」。
//   ③ 只接受同源请求：浏览器 POST 必须来自承接面自己的 origin；跨站不记。
//      这是防止别人把我们的读数刷成噪音。

import express from "express";
import { getDb } from "../../db.js";

/** 事件名闭集。与 README/spec 文案同源；扩集合必须同步改 spec。 */
export const EVENT_NAMES = Object.freeze(["page_view", "cta_click"]);

/** 承接面允许的 origin（同源校验）。可用 env 追加，不硬编码单点。 */
function allowedOrigins() {
  const base = [
    "https://marketing.finddatatech.cloud",
    "https://www.finddatatech.cloud",
    "http://localhost:4321", // astro dev
    "http://localhost:3000",
  ];
  const extra = String(process.env.MARKETING_EVENTS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...base, ...extra]);
}

function enabled() {
  return String(process.env.MARKETING_EVENTS_ENABLED ?? "on").toLowerCase() !== "off";
}

export function registerMarketingEventRoutes(ctx) {
  const { app } = ctx;

  const collectorMissing = () => {
    if (!enabled()) return "MARKETING_EVENTS_ENABLED=off";
    try {
      if (!getDb()) return "database unavailable";
    } catch {
      return "database unavailable";
    }
    return null;
  };

  // 采集口不与读数面共用前缀：采集要匿名可达（访客浏览器），读数面要会话门。
  //
  // CORS：承接面是独立 origin（marketing.finddatatech.cloud），跨域 POST
  // 会先发预检。只对白名单 origin 回 ACAO，且不允许凭据——这条口子本就
  // 不需要 Cookie。
  const cors = (req, res, next) => {
    const origin = String(req.headers.origin || "");
    if (origin && allowedOrigins().has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };

  app.options("/api/marketing/collect", cors);
  app.post("/api/marketing/collect", cors, express.json({ limit: "4kb" }), (req, res) => {
    const missing = collectorMissing();
    if (missing) {
      // 采集端关闭：如实回报，不假装收下了
      return res.status(503).json({ accepted: false, reason: missing });
    }

    const name = String(req.body?.name || "").trim();
    if (!EVENT_NAMES.includes(name)) {
      // 闭集外：拒收并说明，不静默丢弃
      return res.status(400).json({
        accepted: false,
        reason: `unknown event name: ${name || "(empty)"}`,
        acceptedNames: EVENT_NAMES,
      });
    }

    const origin = String(req.headers.origin || "");
    if (origin && !allowedOrigins().has(origin)) {
      return res.status(403).json({ accepted: false, reason: "origin not allowed" });
    }

    const path = String(req.body?.path || "").slice(0, 300);
    const source = String(req.body?.source || "").slice(0, 60);
    try {
      getDb()
        .prepare(
          "INSERT INTO marketing_events (name, path, source, at_ms) VALUES (?, ?, ?, ?)",
        )
        .run(name, path, source, Date.now());
    } catch (err) {
      return res.status(500).json({ accepted: false, reason: `write failed: ${err.message}` });
    }
    res.json({ accepted: true });
  });

  app.get("/api/marketing/events/summary", (req, res) => {
    const missing = collectorMissing();
    if (missing) {
      // 关键：collected:false，不是 counts:0
      return res.json({ collected: false, reason: missing });
    }
    const sinceMs = Number(req.query.since_ms) || Date.now() - 7 * 24 * 3600 * 1000;
    try {
      const rows = getDb()
        .prepare(
          "SELECT name, COUNT(*) AS n FROM marketing_events WHERE at_ms >= ? GROUP BY name",
        )
        .all(sinceMs);
      const counts = Object.fromEntries(EVENT_NAMES.map((n) => [n, 0]));
      for (const r of rows) counts[r.name] = r.n;
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      res.json({
        collected: true,
        since_ms: sinceMs,
        counts,
        total,
      });
    } catch (err) {
      res.json({ collected: false, reason: `read failed: ${err.message}` });
    }
  });
}
