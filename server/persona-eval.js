// ── Persona A/B evaluation harness (add-persona-self-evolution D2) ──────────
//
// The role-bucket twin of skill-eval.js: two arms over the SAME judge lane
// blueprint assertions use (resolveJudgeLane — one resolution chain, no second
// one). Arms differ ONLY in the persona text riding the executor's system
// prompt (current vs amended); the judge ranks ANONYMIZED transcripts (arm
// names never leave this module). Gate: the amended arm must be no worse than
// the current (不劣于) — and the reason must be explainable, which the judge's
// reasoning field carries verbatim.
//
// Text-only harness: no filesystem, no turn execution, no production data —
// the scratch-root discipline degenerates to "no side effects". An interrupted
// call THROWS; the route catches and marks the candidate honestly (评测没跑成
// ≠ 通过).

import { resolveJudgeLane } from "./blueprint-judge.js";

const EVAL_TIMEOUT_MS = () => Number(process.env.PERSONA_EVAL_TIMEOUT_MS || 60_000);
const TRANSCRIPT_KEEP = 1500;

async function callModel(lane, system, user, fetchImpl, usageSink = null) {
  const res = await fetchImpl(`${lane.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(lane.apiKey ? { Authorization: `Bearer ${lane.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: lane.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
    }),
    signal: AbortSignal.timeout(EVAL_TIMEOUT_MS()),
  });
  if (!res.ok) throw new Error(`eval lane HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("eval lane returned empty content");
  // Cost accounting (add-persona-self-evolution 4.3 / add-skill-self-evolution
  // 4.4): the lane reports token usage per call — fold it into the sink so the
  // A/B report carries one honest 账目 row (2 arm calls + 1 judge call).
  const u = data?.usage;
  if (usageSink && u && typeof u === "object") {
    usageSink.calls += 1;
    usageSink.inputTokens += Number(u.prompt_tokens ?? u.inputTokens ?? 0) || 0;
    usageSink.outputTokens += Number(u.completion_tokens ?? u.outputTokens ?? 0) || 0;
  }
  return text;
}

// The arm's system prompt: base discipline + the persona under test. The
// persona IS the arm difference — nothing else varies (design D2).
function executorSystem(persona) {
  const base = "You are a capable assistant. Complete the user's task as well as you can.";
  const p = typeof persona === "string" ? persona.trim() : "";
  if (p) return `${base}\n\nYou operate under the following role definition. Stay in character where it applies:\n\n<persona>\n${p}\n</persona>`;
  return base;
}

function clip(text) {
  return String(text ?? "").length > TRANSCRIPT_KEEP
    ? `${String(text).slice(0, TRANSCRIPT_KEEP)}…[clipped]`
    : String(text ?? "");
}

function parseVerdict(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`judge returned no JSON verdict: ${String(raw).slice(0, 120)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed || typeof parsed.best !== "string") throw new Error("judge verdict missing 'best'");
  return parsed;
}

export async function runPersonaEval({ currentPersona, amendedPersona, scenarioPrompt, fetchImpl = fetch, lane = null } = {}) {
  if (typeof amendedPersona !== "string" || !amendedPersona.trim()) throw new Error("amended persona is required");
  const task = String(scenarioPrompt ?? "").trim();
  if (!task) throw new Error("scenario prompt is required (the evidence scene the amendment claims to help)");

  if (!lane) lane = resolveJudgeLane();
  if (!lane?.baseUrl || !lane?.model) throw new Error("no judge lane available on this deployment");

  // ── arms ────────────────────────────────────────────────────────────────────
  const arms = [
    { key: "current", persona: currentPersona ?? "" },
    { key: "amended", persona: amendedPersona },
  ];
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  for (const arm of arms) {
    arm.transcript = clip(await callModel(lane, executorSystem(arm.persona), task, fetchImpl, usage));
  }

  // ── blind ranking (shuffle → 甲/乙 → map back) ─────────────────────────────
  const shuffled = [...arms];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const zhLabels = ["甲", "乙"];
  shuffled.forEach((arm, i) => { arm.label = zhLabels[i]; });
  const judgeUser = [
    `任务：\n${task}`,
    "",
    ...shuffled.map((a) => `【回答${a.label}】\n${a.transcript}`),
    "",
    "请比较以上回答，只输出一个 JSON 对象：{\"best\":\"甲|乙|tie\",\"reasoning\":\"≤120字\"}。标准：哪个回答更好地完成了任务（正确性、完整性、符合各自角色定位的可执行性）。不要输出其他内容。",
  ].join("\n");
  const raw = await callModel(lane, "You are a strict, anonymous evaluator.", judgeUser, fetchImpl, usage);
  const verdict = parseVerdict(raw);

  const byLabel = Object.fromEntries(shuffled.map((a) => [a.label, a]));
  const best = verdict.best === "tie" ? "tie" : (byLabel[verdict.best]?.key ?? "unknown");

  // ── gate: amended no worse than current (不劣于, 双钥匙的 AI 侧证据) ────────
  let passed = false;
  let reason;
  if (best === "amended") {
    passed = true; reason = "amended persona ranked best";
  } else if (best === "tie") {
    passed = true; reason = "tie — stability-grade parity (不劣于)";
  } else if (best === "current") {
    reason = "current persona ranked best — the amendment regresses";
  } else {
    reason = `judge verdict unmappable: ${best}`;
  }

  return {
    passed,
    reason,
    verdict: { best, reasoning: clip(verdict.reasoning, 300) },
    lane: { model: lane.model, laneId: lane.laneId ?? null },
    usage,
    arms: arms.map((a) => ({ key: a.key, label: a.label, transcript: a.transcript })),
    evaluatedAt: new Date().toISOString(),
  };
}
