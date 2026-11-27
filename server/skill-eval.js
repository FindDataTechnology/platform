// ── Skill A/B evaluation harness (add-skill-self-evolution D2) ──────────────
//
// Two-arm (supersedes candidates: three-arm) evaluation over the SAME judge
// lane blueprint assertions use (resolveJudgeLane — one resolution chain, no
// second one). Arms differ ONLY in whether the candidate/old skill body rides
// the executor's context; the judge ranks ANONYMIZED transcripts (arm names
// never leave this module). Gate: the candidate arm must be no worse than the
// control (and the old arm for supersedes) — "不劣于", because a skill's value
// is often stability rather than peak quality.
//
// Text-only harness: no filesystem, no turn execution, no production data —
// the scratch-root discipline degenerates to "no side effects". An interrupted
// call THROWS; the route catches and marks the candidate honestly (评测没跑成
// ≠ 通过).

import { resolveJudgeLane } from "./blueprint-judge.js";

const EVAL_TIMEOUT_MS = () => Number(process.env.SKILL_EVAL_TIMEOUT_MS || 60_000);
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
  // Cost accounting (add-skill-self-evolution 4.4): fold the lane's per-call
  // token usage into the sink so the A/B report carries one honest 账目 row.
  const u = data?.usage;
  if (usageSink && u && typeof u === "object") {
    usageSink.calls += 1;
    usageSink.inputTokens += Number(u.prompt_tokens ?? u.inputTokens ?? 0) || 0;
    usageSink.outputTokens += Number(u.completion_tokens ?? u.outputTokens ?? 0) || 0;
  }
  return text;
}

function executorSystem(skillBody) {
  const base = "You are a capable assistant. Complete the user's task as well as you can.";
  if (skillBody) {
    return `${base}\n\nYou have the following skill guidance available. Follow it where it applies:\n\n<skill>\n${skillBody}\n</skill>`;
  }
  return base;
}

function clip(text) {
  return String(text ?? "").length > TRANSCRIPT_KEEP
    ? `${String(text).slice(0, TRANSCRIPT_KEEP)}…[clipped]`
    : String(text ?? "");
}

function parseVerdict(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`judge returned no JSON verdict: ${clip(raw, 120)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed || typeof parsed.best !== "string") throw new Error("judge verdict missing 'best'");
  return parsed;
}

export async function runSkillEval({ candidate, scenarioPrompt, fetchImpl = fetch, lane = null, oldSkillBody = null } = {}) {
  if (!candidate?.body) throw new Error("candidate body is required");
  const task = String(scenarioPrompt ?? "").trim();
  if (!task) throw new Error("scenario prompt is required (the evidence scene the candidate claims to help)");

  if (!lane) lane = resolveJudgeLane();
  if (!lane?.baseUrl || !lane?.model) throw new Error("no judge lane available on this deployment");

  // ── arms ────────────────────────────────────────────────────────────────────
  const arms = [{ key: "control", label: null, skill: null }];
  if (candidate.supersedes) {
    arms.push({ key: "old", label: null, skill: oldSkillBody });
  }
  arms.push({ key: "candidate", label: null, skill: candidate.body });

  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  for (const arm of arms) {
    arm.transcript = clip(await callModel(lane, executorSystem(arm.skill), task, fetchImpl, usage));
  }

  // ── blind ranking (shuffle → 甲/乙/丙 → map back) ───────────────────────────
  const shuffled = [...arms];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const zhLabels = ["甲", "乙", "丙"];
  shuffled.forEach((arm, i) => { arm.label = zhLabels[i]; });

  // ── guidance ground truth (fix-skill-eval-guidance-groundtruth) ───────────
  // The judge sees the GUIDANCE TEXTS blind-labeled (指导文档一/二), shuffled
  // independently from the answer labels: a claim grounded in ANY guidance doc
  // (or the task) is legitimate; a claim in neither is unfounded — applied
  // symmetrically to every arm. Grounding only settles claim verification;
  // quality stays task-completion based, so a longer document never wins on
  // its own. §15.135: without this the judge flagged a policy-bearing
  // candidate's clauses as 臆造 while the guidance-less control's invented
  // values escaped the same scrutiny — the supersedes promote leg was
  // structurally locked for policy-type skills.
  const guidanceDocs = [{ body: candidate.body }];
  if (candidate.supersedes && oldSkillBody) guidanceDocs.unshift({ body: oldSkillBody });
  const docLabels = guidanceDocs.length > 1 ? ["指导文档一", "指导文档二"] : ["指导文档"];
  const shuffledDocs = [...guidanceDocs];
  for (let i = shuffledDocs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledDocs[i], shuffledDocs[j]] = [shuffledDocs[j], shuffledDocs[i]];
  }
  const docSections = shuffledDocs.map((d, i) => `【${docLabels[i]}】\n${clip(d.body)}`);
  const groundingRules =
    "上述回答的作者完成任务时分别参考了下面的指导文档。真值核验规则（对称适用于全部回答）：回答中的政策/事实性声明，凡与任一指导文档或任务文本一致，视为有据；任何指导文档与任务文本都不含的声明，视为无据（准确性存疑）。有据性只回答『声明是否有出处』，回答的优劣仍按完成任务的程度（正确性、完整性、可执行性）评定，与所引文档的长度无关。";
  const judgeUser = [
    `任务：\n${task}`,
    "",
    ...shuffled.map((a) => `【回答${a.label}】\n${a.transcript}`),
    "",
    ...docSections,
    "",
    groundingRules,
    "",
    "请比较以上回答，只输出一个 JSON 对象：{\"best\":\"甲|乙|丙|tie\",\"reasoning\":\"≤120字\"}。标准：哪个回答更好地完成了任务（正确性、完整性、可执行性）。不要输出其他内容。",
  ].join("\n");
  const raw = await callModel(lane, "You are a strict, anonymous evaluator.", judgeUser, fetchImpl, usage);
  const verdict = parseVerdict(raw);

  const byLabel = Object.fromEntries(shuffled.map((a) => [a.label, a]));
  const best = verdict.best === "tie" ? "tie" : (byLabel[verdict.best]?.key ?? "unknown");

  // ── gate: candidate no worse than control (and old, for supersedes) ────────
  let passed = false;
  let reason;
  if (best === "candidate") {
    passed = true; reason = "candidate ranked best";
  } else if (best === "tie") {
    passed = true; reason = "tie — stability-grade parity (不劣于)";
  } else if (best === "control") {
    reason = "control ranked best — candidate is worse";
  } else if (best === "old") {
    reason = "old skill ranked best — candidate regresses on its own supersedes target";
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
