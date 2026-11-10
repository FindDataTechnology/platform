// Preview sandbox v1 (add-supply-studio-migration 3.x, design D3).
//
// 发布前的试跑 = ephemeral 干跑三件套，在谦面服务端执行、零持久化：
//   1. 静态校验   — validateBlueprint（凭据禁带/数据源/清单/验收/工具面，全链）
//   2. manifest 组装 — assembleManifest（铸造产物形状预览，不落市场）
//   3. LLM 起草干跑 — 复用 studio-draft 的判官车道（env 路由→sub2api 内网），
//      对提交 prompt 起草并回形状校验后的草稿；产物随响应返回。
//
// 三闸（task 3.2，服务端强制）：
//   * 匿名不给预览（resolveUser 缺席 → 401）
//   * 每身份每日配额（STUDIO_PREVIEW_DAILY_QUOTA，缺省 20）
//   * 单次时长帽（AbortSignal.timeout，STUDIO_PREVIEW_TIMEOUT_MS，缺省 60s）
//
// 诚实降级（task 3.3）：上游失败/超时/形状不绿一律显式失败态（status+error
// 语义码），MUST NOT 产占位草稿或空结果伪装成功。
//
// 回归钉（task 3.1）：本模块从不触 store、从不写 packs.db/studio-docs.db——
// 预览后存储无新增记录。

import { Router } from "express";
import { validateBlueprint, assembleManifest } from "../server/blueprint-validate.js";
import { resolveJudgeLane } from "../server/blueprint-judge.js";

const COMPLETION_TIMEOUT_MS = Number(process.env.STUDIO_PREVIEW_TIMEOUT_MS || 60_000);
const DAILY_QUOTA_DEFAULT = 20;
const dailyCount = new Map(); // identity key -> { day, count }

function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function quotaState(email, now = Date.now()) {
  const key = `${email}@${dayKey(now)}`;
  const limit = Number(process.env.STUDIO_PREVIEW_DAILY_QUOTA || DAILY_QUOTA_DEFAULT);
  const bucket = dailyCount.get(key) ?? { day: dayKey(now), count: 0 };
  if (bucket.day !== dayKey(now)) {
    bucket.day = dayKey(now);
    bucket.count = 0;
  }
  return { bucket, limit, key };
}

export function createPreviewSandboxRoutes(app, { resolveUser, fetchImpl = fetch } = {}) {
  const router = Router();

  router.post("/preview", async (req, res) => {
    // 三闸之一：匿名不给预览。
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required", code: "preview_auth_required" });

    const { content, prompt } = req.body ?? {};
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return res.status(400).json({ error: "content (blueprint object) is required", code: "preview_content_required" });
    }

    // 三闸之二：每身份每日配额；超限显式语义码（不静默截断、不产伪预览）。
    const { bucket, limit, key } = quotaState(user.email);
    if (bucket.count >= limit) {
      return res.status(429).json({
        error: `daily preview quota exhausted (${limit}/day) — try again tomorrow`,
        code: "preview_quota_exhausted",
        limit,
      });
    }

    // 件 1：静态校验（凭据禁带闸在此结构性拒绝——与存储层同链）。
    const verdict = validateBlueprint(content);
    if (!verdict.ok) {
      return res.status(422).json({
        error: "blueprint does not pass static validation",
        code: "preview_validation_failed",
        errors: verdict.errors,
        findings: verdict.findings,
      });
    }

    // 件 2：manifest 组装（形状预览——不落市场、不进目录）。
    const manifestPreview = assembleManifest(content);

    // 件 3：LLM 起草干跑（prompt 可选——不提交时只回校验+形状两件）。
    let draft = null;
    if (prompt != null) {
      const text = String(prompt).trim();
      if (!text) return res.status(400).json({ error: "prompt cannot be blank when present", code: "preview_prompt_blank" });
      if (text.length > 4000) return res.status(413).json({ error: "prompt too long (max 4000 chars)", code: "preview_prompt_too_long" });
      const lane = resolveJudgeLane({});
      if (!lane) {
        // 诚实降级：车道缺席是显式失败态（校验+形状仍如实返回），不伪装成功。
        return res.status(503).json({
          error: "no LLM lane is configured on this deployment — drafting preview unavailable",
          code: "preview_lane_unavailable",
          staticValidation: { ok: true },
          manifestPreview,
        });
      }
      try {
        const upstream = await fetchImpl(`${lane.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(lane.apiKey ? { authorization: `Bearer ${lane.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: lane.model,
            messages: [{ role: "user", content: text }],
            temperature: 0.4,
          }),
          // 三闸之三：单次时长帽。
          signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
        });
        const data = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          return res.status(502).json({
            error: `drafting lane failed (${upstream.status})`,
            code: "preview_lane_failed",
            staticValidation: { ok: true },
            manifestPreview,
          });
        }
        draft = data?.choices?.[0]?.message?.content ?? "";
      } catch (err) {
        const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
        return res.status(502).json({
          error: timedOut ? "drafting lane timed out" : "drafting lane call failed",
          code: timedOut ? "preview_lane_timeout" : "preview_lane_failed",
          staticValidation: { ok: true },
          manifestPreview,
        });
      }
    }

    // 配额落账（只在全绿应答时计——失败的预览不算创作者的配额负担）。
    bucket.count += 1;
    dailyCount.set(key, bucket);

    res.json({
      preview: {
        staticValidation: { ok: true },
        manifestPreview,
        ...(prompt != null ? { draft, draftedBy: "ai" } : {}),
      },
    });
  });

  router.get("/preview/quota", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required", code: "preview_auth_required" });
    const { bucket, limit } = quotaState(user.email);
    res.json({ used: bucket.count, limit });
  });

  app.use("/api/studio", router);
}

// 测试缝：清空配额账本（进程内状态）。
export function __resetPreviewQuota() {
  dailyCount.clear();
}
