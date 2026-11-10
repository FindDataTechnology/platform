// ── 记忆读面 + 浏览 API（add-unified-memory-and-outputs 3.3 / 4.1）───────────
//
// 壹座「记忆」面板与萬星 console 部署者视角共用同一条代理：以调用者身份的
// person 令牌（owner 自视）或受信 platform lane（deployer 看 d/）读 fd-memory
// 的 visibility 读面（/memory）：scope/layer/tier/tag/time 筛选语义与
// fd-memory 现状全同，本层只做身份解析与透传，不再多建一套查询语言。

import { cellMemoryConfig, personTokenFor } from "@finddatatechnology/yongyi-client";

function intParam(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function registerMemoryRoutes(ctx) {
  const { app } = ctx;

  // GET /api/memory/entries — owner 范围（person 令牌，fd-memory 侧按 scope
  // 解析本人 root）。same 原生语义：agent 令牌不入此面。
  app.get("/api/memory/entries", async (req, res) => {
    try {
      const cfg = cellMemoryConfig(process.env);
      if (!cfg) return res.status(503).json({ error: "记忆服务未配置", code: "memory_unavailable" });
      const email = req.user?.email ?? null;
      if (!email) return res.status(401).json({ error: "未登录", code: "unauthenticated" });
      const token = await personTokenFor(cfg, email);
      if (!token) return res.status(503).json({ error: "记忆令牌不可用", code: "memory_unavailable" });
      const q = req.query ?? {};
      const u = new URL(`${cfg.url}/memory`);
      // project 透传（add-memory-visible-ux 任务 4）：fd-memory visibility 面
      // 原生支持 project 参数，本层只透传不加解——非空字符串才带，缺省不带
      // （不带该键的字节与改动前逐字节一致，回滚零差）。
      for (const [k, v] of [
        ["scope", q.scope], ["layer", q.layer], ["tier", q.tier], ["since", q.since], ["until", q.until],
        ["project", q.project],
      ]) {
        if (typeof v === "string" && v.trim()) u.searchParams.set(k, v.trim());
      }
      const tagParam = typeof q.tag === "string" && q.tag.trim() ? q.tag.split(",").map((t) => t.trim()).filter(Boolean) : [];
      for (const tag of tagParam) u.searchParams.append("tag", tag);
      u.searchParams.set("limit", String(intParam(q.limit, 50, 1, 200)));
      u.searchParams.set("offset", String(intParam(q.offset, 0, 0, 1_000_000)));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const r = await fetch(u, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
        if (!r.ok) return res.status(502).json({ error: `记忆读面 HTTP ${r.status}`, code: "memory_read_failed" });
        const doc = await r.json();
        return res.json(Array.isArray(doc) ? { items: doc } : doc);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // degrade-open：面板显示降级态，不影响其它功能。
      return res.status(503).json({ error: String(err?.message ?? err), code: "memory_unavailable" });
    }
  });

  // GET /api/memory/promotions — 待确认晋升面（add-tier-promotion-candidates
  // 5.1）：AI 只提议，人接受/忽略。owner 身份走 person 令牌，与 /entries 同缝。
  app.get("/api/memory/promotions", async (req, res) => {
    try {
      const cfg = cellMemoryConfig(process.env);
      if (!cfg) return res.status(503).json({ error: "记忆服务未配置", code: "memory_unavailable" });
      const email = req.user?.email ?? null;
      if (!email) return res.status(401).json({ error: "未登录", code: "unauthenticated" });
      const token = await personTokenFor(cfg, email);
      if (!token) return res.status(503).json({ error: "记忆令牌不可用", code: "memory_unavailable" });
      const u = new URL(`${cfg.url}/memory/promotions`);
      if (typeof req.query?.scope === "string" && req.query.scope.trim()) u.searchParams.set("scope", req.query.scope.trim());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const r = await fetch(u, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
        if (!r.ok) return res.status(502).json({ error: `晋升读面 HTTP ${r.status}`, code: "memory_read_failed" });
        return res.json(await r.json());
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return res.status(503).json({ error: String(err?.message ?? err), code: "memory_unavailable" });
    }
  });

  // POST /api/memory/promotions/{accept,ignore} — 人的手势。接受才翻 tier
  // （且 tier_origin=human，fd-memory 侧强制）；忽略进冷却。body {path}。
  for (const gesture of ["accept", "ignore"]) {
    app.post(`/api/memory/promotions/${gesture}`, async (req, res) => {
      try {
        const cfg = cellMemoryConfig(process.env);
        if (!cfg) return res.status(503).json({ error: "记忆服务未配置", code: "memory_unavailable" });
        const email = req.user?.email ?? null;
        if (!email) return res.status(401).json({ error: "未登录", code: "unauthenticated" });
        const token = await personTokenFor(cfg, email);
        if (!token) return res.status(503).json({ error: "记忆令牌不可用", code: "memory_unavailable" });
        const path = typeof req.body?.path === "string" ? req.body.path.trim() : "";
        if (!path) return res.status(400).json({ error: "path_required", code: "path_required" });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const r = await fetch(`${cfg.url}/memory/promotions/${gesture}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ path }),
            signal: controller.signal,
          });
          const doc = await r.json().catch(() => ({}));
          if (!r.ok && r.status !== 409) return res.status(502).json({ error: `晋升手势 HTTP ${r.status}`, code: "memory_gesture_failed", ...doc });
          return res.status(r.status === 409 ? 409 : 200).json(doc);
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        return res.status(503).json({ error: String(err?.message ?? err), code: "memory_unavailable" });
      }
    });
  }

  // GET /api/memory/deployer-entries?rootKey=d-<packId>-<agentId> — 万星 console
  // 部署者视角：platform lane + 显式 rootKey（与 fd-memory 的 rootKey 语义一致），
  // 只有受信面调用（fleet/agent 详情），不暴露给普通用户会话。
  app.get("/api/memory/deployer-entries", async (req, res) => {
    try {
      const cfg = cellMemoryConfig(process.env);
      if (!cfg) return res.status(503).json({ error: "记忆服务未配置", code: "memory_unavailable" });
      const rootKey = typeof req.query?.rootKey === "string" ? req.query.rootKey.trim() : "";
      if (!rootKey) return res.status(400).json({ error: "rootKey_required", code: "rootKey_required" });
      const platformToken = process.env.CELL_MEMORY_PLATFORM_TOKEN ?? "";
      if (!platformToken) return res.status(503).json({ error: "记忆平台令牌未配置", code: "memory_unavailable" });
      const q = req.query ?? {};
      const u = new URL(`${cfg.url}/memory`);
      u.searchParams.set("rootKey", rootKey);
      for (const [k, v] of [["scope", q.scope], ["layer", q.layer], ["tier", q.tier], ["since", q.since], ["until", q.until]]) {
        if (typeof v === "string" && v.trim()) u.searchParams.set(k, v.trim());
      }
      u.searchParams.set("limit", String(intParam(q.limit, 50, 1, 200)));
      u.searchParams.set("offset", String(intParam(q.offset, 0, 0, 1_000_000)));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const r = await fetch(u, { headers: { authorization: `Bearer ${platformToken}` }, signal: controller.signal });
        if (!r.ok) return res.status(502).json({ error: `记忆读面 HTTP ${r.status}`, code: "memory_read_failed" });
        const doc = await r.json();
        return res.json(Array.isArray(doc) ? { items: doc } : doc);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return res.status(503).json({ error: String(err?.message ?? err), code: "memory_unavailable" });
    }
  });
}
