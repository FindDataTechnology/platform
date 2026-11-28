// ── 记忆读面 + 浏览 API（add-unified-memory-and-outputs 3.3 / 4.1）───────────
//
// 壹座「记忆」面板与萬星 console 部署者视角共用同一条代理：以调用者身份的
// person 令牌（owner 自视）或受信 platform lane（deployer 看 d/）读 fd-memory
// 的 visibility 读面（/memory）：scope/layer/tier/tag/time 筛选语义与
// fd-memory 现状全同，本层只做身份解析与透传，不再多建一套查询语言。

import { cellMemoryConfig, personTokenFor } from "@finddatatechnology/yongyi-client";
import * as dbModule from "../../db.js";
import { memoryRows, unexecutedMemory } from "../../lib/pack-memory.js";
import { packMemoryRootKey } from "../../lib/pack-memory-policy.js";

/**
 * The declaration a preview must show, with `knowledge.memory` folded in as the
 * `read` axis when `memory.read` is absent.
 *
 * Both spellings name the same axis (spec: "knowledge.memory 是 read 轴的等价写法").
 * Publish/install already refuse a manifest where both speak and disagree, so this
 * only has to handle the "one of them spoke" case — and it must not invent values:
 * `enabled: false` is the old spelling of `scope: "off"`, and nothing else maps.
 */
function declarationFor(manifest) {
  const decl = manifest?.memory && typeof manifest.memory === "object" ? { ...manifest.memory } : {};
  if (!decl.read) {
    const legacy = manifest?.knowledge?.memory;
    if (legacy && typeof legacy === "object") {
      const read = {};
      if (legacy.enabled === false) read.scope = "off";
      else if (typeof legacy.scope === "string") read.scope = legacy.scope;
      if (Number.isInteger(legacy.budget)) read.budget = legacy.budget;
      if (Object.keys(read).length) decl.read = read;
    }
  }
  return decl;
}


function intParam(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function registerMemoryRoutes(ctx) {
  const { app } = ctx;
  // Injection seam for the declaration preview: an ESM namespace object cannot be
  // monkeypatched, and a test that had to install a real pack into a real DB would
  // be testing the fixture, not this route. Absent ⇒ the real store
  // (same pattern as `deps.syncMemoryPolicy` in fleet-provisioner).
  const getInstalledPack = typeof ctx?.getInstalledPack === "function" ? ctx.getInstalledPack : dbModule.getInstalledPack;

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

  // GET /api/memory/policy?packId=<id> — 处理策略读面（add-pack-memory-
  // declaration 3.3/4.x）：fd-memory `/policy` 的四列（declared /
  // inherited_from / effective / executed）+ 未执行清单，按 pack 记忆根解析。
  //
  // 三处是刻意的：
  //   · 只收 `packId`，根键由 `packMemoryRootKey()` 推出来 —— 让调用方自己指定
  //     rootKey 就等于让它指定「写进谁的 store」，与 `store.home` 只收枚举同一条边界。
  //   · 响应带 `policy_root`：策略作用域是 pack 根，不是某一个 fleet 行（同一 pack
  //     被不同所有者各落地一个团队时共用这一份）。读面必须让人看得出作用域。
  //   · 用 platform lane（与 /deployer-entries 同缝），但**额外要求已登录**：
  //     这条比邻居更严，因为新面不该比既有的更宽。
  app.get("/api/memory/policy", async (req, res) => {
    try {
      const cfg = cellMemoryConfig(process.env);
      if (!cfg) return res.status(503).json({ error: "记忆服务未配置", code: "memory_unavailable" });
      if (!req.user?.email) return res.status(401).json({ error: "未登录", code: "unauthenticated" });
      const packId = typeof req.query?.packId === "string" ? req.query.packId.trim() : "";
      const rootKey = packMemoryRootKey(packId);
      if (!rootKey) {
        return res.status(400).json({
          error: "packId 缺失或形状非法（字母数字_-，1-64 字符）",
          code: "pack_id_invalid",
        });
      }
      const platformToken = process.env.CELL_MEMORY_PLATFORM_TOKEN ?? "";
      if (!platformToken) return res.status(503).json({ error: "记忆平台令牌未配置", code: "memory_unavailable" });
      const u = new URL(`${cfg.url}/policy`);
      u.searchParams.set("rootKey", rootKey);
      const project = typeof req.query?.project === "string" ? req.query.project.trim() : "";
      if (project) u.searchParams.set("project", project);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const r = await fetch(u, { headers: { authorization: `Bearer ${platformToken}` }, signal: controller.signal });
        if (!r.ok) return res.status(502).json({ error: `策略读面 HTTP ${r.status}`, code: "memory_read_failed" });
        const doc = await r.json();
        // `scope: "pack"` + `policy_root` 一起出现，是为了让 UI 不可能把它渲染成
        // 「只影响本合同」——那是 D8 明确禁止的表述。
        return res.json({ ...doc, packId, policy_root: rootKey, scope: "pack" });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return res.status(503).json({ error: String(err?.message ?? err), code: "memory_unavailable" });
    }
  });

  // GET /api/memory/declaration?packId=<id> — 四轴声明预览
  // （fix-memory-axes-executed-truth / pack-memory-declaration「四列读面」）
  //
  // 与上一条 `/api/memory/policy` 分工明确：**这条回答「pack 要求什么」，那条回答
  // 「记忆服务里存着什么」**。两者不能混成一份响应，理由有两条：
  //   · 预览的数据来自**已安装的 manifest**，记忆服务挂掉也必须照常出表——把两者
  //     绑在一起，服务一坏预览就变成一张全默认的表，那会被读成「这个 pack 什么都没声明」。
  //   · process 轴的两个来源会不一致（pack 声明 vs 服务里实际存的行），混在一起后
  //     没人能分清「声明了没生效」与「生效值来自上一层」。
  //
  // 边界与 policy 读面同一条：只收 `packId`，根键由 `packMemoryRootKey()` 推出；
  // 调用方给 `rootKey` 一律忽略——让它指定「写进谁的 store」就等于绕过 pack 边界。
  //
  // `executed` 只在能指出消费方时为 true：本版本只有 `process.distill` 有消费方，
  // 三个作者侧轴（store/read/write）与 promote_after/cold_after_days 都如实标未执行。
  app.get("/api/memory/declaration", async (req, res) => {
    try {
      if (!req.user?.email) return res.status(401).json({ error: "未登录", code: "unauthenticated" });
      const packId = typeof req.query?.packId === "string" ? req.query.packId.trim() : "";
      const rootKey = packMemoryRootKey(packId);
      if (!rootKey) {
        return res.status(400).json({
          error: "packId 缺失或形状非法（字母数字_-，1-64 字符）",
          code: "pack_id_invalid",
        });
      }
      const installed = getInstalledPack(packId);
      if (!installed?.manifest) {
        // 不返回一张全默认的表：那与「声明了默认值」逐字同形，正是本变更要消灭的
        // 「看起来正常」。
        return res.status(404).json({ error: `pack '${packId}' is not installed here`, code: "pack_not_installed" });
      }
      const rows = memoryRows([["pack", declarationFor(installed.manifest)]]);
      return res.json({
        packId,
        version: installed.version ?? null,
        policy_root: rootKey,
        scope: "pack",
        source: "declaration",
        rows,
        not_executed: unexecutedMemory(rows),
      });
    } catch (err) {
      return res.status(503).json({ error: String(err?.message ?? err), code: "memory_unavailable" });
    }
  });
}
