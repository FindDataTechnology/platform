// Studio AI drafting bridge (add-studio-ai-drafting) — the canvas's 「AI 起草」
// accelerator. AI drafts are ACCELERATORS, not automation: the model's output
// lands ONLY as an editable canvas draft; the human 「采用」 is the single
// gate into the three buckets, and the four emit mouths are never fed by the
// model directly (capability spec studio-ai-drafting).
//
// The bridge is deliberately ONE function, not a tool proxy: there is no
// pass-through surface for arbitrary tool names, so the whitelist
// (起草类 only) is structural — nothing else is reachable. Auth rides the
// same session/user resolution as every routes-family surface; an anonymous
// caller gets the family-standard 401. Nothing here persists: the endpoint
// returns a draft and forgets it.

import { Router } from "express";
import { resolveJudgeLane } from "../blueprint-judge.js";

const DRAFT_KINDS = ["agent-doc", "blueprint"];
const RATE_LIMIT = { windowMs: 60 * 60_000, max: 20 };
const COMPLETION_TIMEOUT_MS = 60_000;

// Per-caller in-memory bucket — the draft is cheap but the lane is not.
const buckets = new Map();
function rateLimited(email, now = Date.now()) {
  const b = buckets.get(email);
  if (!b || now - b.start > RATE_LIMIT.windowMs) {
    buckets.set(email, { start: now, count: 1 });
    return false;
  }
  b.count += 1;
  return b.count > RATE_LIMIT.max;
}

const SCHEMAS = {
  "agent-doc": `你是壹座 Studio 的起草器。根据用户描述产出一份 agent 文档草稿，只输出 JSON，不要输出任何解释或代码围栏。
形状（三桶）：
{"name": "…", "description": "…", "persona": "…", "skills": [{"name": "…", "description": "…", "content": "…"}], "mcpServers": [{"registryName": "…", "allowTools": []}]}
纪律：persona 用第二人称写清楚角色与边界；skills 只写真实需要的（1-3 条，content 是可执行的操作说明）；不确定的 MCP 一律留空数组。`,
  blueprint: `你是壹座 Studio 的起草器。根据用户描述产出一份蓝图内容草稿，只输出 JSON，不要输出任何解释或代码围栏。
形状：
{"boundary": {"name": "…", "oneLine": "…", "outOfScope": "…"}, "dataSources": [], "fleet": {"name": "…", "members": [{"ref": "唯一短名", "title": "…", "target": {"kind": "pack-preset", "packId": "{{PACK_ID:self}}", "presetId": "…"}], "cadence": {"cron": "*/30 * * * *", "tz": "Asia/Shanghai", "promptTemplate": "…"}}}, "acceptance": [{"id": "…", "kind": "report-landed", "target": "…"}, {"id": "…", "kind": "llm-judged", "target": "…", "rubric": "…"}]}
纪律：成员 1-3 个；promptTemplate 写清楚岗位每轮做什么、收尾调用 report_status；acceptance 至少一条 report-landed；不确定的数据源留空数组。`,
};

function extractJson(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(body.slice(start, end + 1));
}

function shapeOk(kind, draft) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return "draft is not an object";
  if (kind === "agent-doc") {
    if (typeof draft.name !== "string" || !draft.name.trim()) return "draft.name missing";
    if (typeof draft.persona !== "string" || !draft.persona.trim()) return "draft.persona missing";
    if (draft.skills !== undefined && !Array.isArray(draft.skills)) return "draft.skills must be an array";
  } else {
    if (!draft.boundary || typeof draft.boundary.name !== "string" || !draft.boundary.name.trim()) return "draft.boundary.name missing";
    if (!draft.fleet || !Array.isArray(draft.fleet.members) || draft.fleet.members.length === 0) return "draft.fleet.members missing";
  }
  return null;
}

export function createStudioDraftRoutes(app, ctx = null, { fetchImpl = fetch } = {}) {
  const resolveUser = (req) => req.user ?? (ctx?.authEnabled ? null : { email: ctx?.cellUserEmail || "owner@local", groups: [] });
  const router = Router();

  router.post("/draft", async (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    const { kind, prompt } = req.body ?? {};
    if (!DRAFT_KINDS.includes(kind)) {
      // 白名单即结构：桥只起草，kind 之外没有第二件事可请求。
      return res.status(400).json({ error: `kind must be one of ${DRAFT_KINDS.join(", ")}` });
    }
    const text = String(prompt ?? "").trim();
    if (!text) return res.status(400).json({ error: "prompt is required" });
    if (text.length > 4000) return res.status(413).json({ error: "prompt too long (max 4000 chars)" });
    if (rateLimited(user.email)) return res.status(429).json({ error: "drafting rate limit reached (20/hour)" });

    const lane = resolveJudgeLane({});
    if (!lane) {
      return res.status(503).json({ error: "no LLM lane is configured on this deployment — drafting unavailable" });
    }
    let content;
    try {
      const res2 = await fetchImpl(`${lane.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(lane.apiKey ? { authorization: `Bearer ${lane.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: lane.model,
          messages: [
            { role: "system", content: SCHEMAS[kind] },
            { role: "user", content: text },
          ],
          temperature: 0.4,
        }),
        signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
      });
      const data = await res2.json().catch(() => ({}));
      if (!res2.ok) {
        return res.status(502).json({ error: `drafting lane failed (${res2.status})` });
      }
      const out = data?.choices?.[0]?.message?.content ?? "";
      content = extractJson(out);
    } catch (err) {
      const reason = err?.name === "TimeoutError" || err?.name === "AbortError" ? "drafting lane timed out" : "drafting lane call failed";
      return res.status(502).json({ error: reason });
    }
    const bad = shapeOk(kind, content);
    if (bad) return res.status(502).json({ error: `model draft rejected: ${bad}` });
    // 只产草稿：响应即终点，零持久化、零发射。provenance 如实标记。
    res.json({ draft: content, draftedBy: "ai", kind });
  });

  app.use("/api/studio", router);
}
