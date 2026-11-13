#!/usr/bin/env node
// 判据模型选型探针（blueprint-judge）：对候选模型跑「三态区分力」测试。
//
// 为什么必须测区分力而不是只测可用性：一个永远说 pass 的评委等于没有评委。
// 2026-10-29 首次实跑：cohere/north-mini-code:free 在可达窗口内也从未判对过，
// 而 deepseek-v4-pro 9/9 全对——两者「看起来都能调通」，区分力却天差地别。
//
// 三组用例 × 3 次，每组期望不同判决：
//   A 证据充分支持 → pass
//   B 证据明确违反 → fail
//   C 证据只沾边/缺载体 → insufficient-evidence
// 满分 9。parsed 与 score 分开报：解析失败（输出不是 JSON）单独可见，
// 免得把「模型不会按格式答」误当成「判错」。
//
//   # 在生产 pod 内跑（车道的 key 不出容器）
//   kubectl --context cheap -n fd-prod cp scripts/probe-blueprint-judge-model.mjs <pod>:/tmp/bench.mjs
//   kubectl --context cheap exec -n fd-prod <pod> -- sh -c 'CANDIDATES="a,b" node /tmp/bench.mjs'
//
//   文件进出用 kubectl cp，不要用 `exec -i … sh -c 'cat > path' < localfile`：
//   后者在客户端中断/stdin 未正常关闭时容器内 cat 永远等 EOF，进程与管道都不
//   释放（2026-10-30 在 cheap-1 清出三个跑了 15 天的僵死 cat，各烧 ~40% CPU
//   把主机 load 顶到 60+）。必须走 exec 流式时加 timeout 兜底。
//
// 车道抖动纪律：429/5xx 自带指数退避重试（单发失败即弃跑会烧掉整轮，测出来
// 的分数是噪声）。见 memory sub2api-embedding-rerank-lanes。

const BASE = (process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.LLM_API_KEY || "";
const RETRIES = Number(process.env.BENCH_RETRIES || 4);

const SYSTEM = [
  "你是验收判据的独立评审，不是这份产出的作者。",
  "只依据下面的运行证据判断判据是否满足；证据没有覆盖到的部分，判 insufficient-evidence，不要凭常识补全，也不要因为判据写得漂亮就通过。",
  "输出严格的 JSON，且只输出 JSON：",
  '{"verdict":"pass|fail|insufficient-evidence","reason":"不超过 120 字"}',
  "判定口径：pass=证据直接支持判据；fail=证据明确违反判据；insufficient-evidence=证据不足以判断（含证据为空、只沾边不直接支持）。",
].join("\n");

const RUBRIC = "分诊岗与处置岗两个岗位在试跑集群中均已落位";

const CASES = [
  {
    id: "A-充分",
    expect: "pass",
    evidence: "试跑集群：工单分诊集群·试跑（fleet_1）\n岗位：分诊岗(已落位)、处置岗(已落位)\n回合：2 个（job_1, job_2）",
  },
  {
    id: "B-违反",
    expect: "fail",
    evidence: "试跑集群：工单分诊集群·试跑（fleet_0）\n岗位：分诊岗(空缺)\n回合：0 个\n注：处置岗未创建",
  },
  {
    id: "C-缺载体",
    expect: "insufficient-evidence",
    evidence: "岗位：分诊岗(已落位)\n回合：1 个（job_9）",
  },
];

// 与 server/blueprint-judge.js 的解析口径一致：逐个 } 由后向前试解。
function parseVerdict(text) {
  const s = text.indexOf("{");
  if (s < 0) return null;
  for (let i = text.length - 1; i > s; i -= 1) {
    if (text[i] !== "}") continue;
    try {
      const o = JSON.parse(text.slice(s, i + 1));
      if (o && typeof o === "object" && o.verdict) return String(o.verdict);
    } catch {
      // 换下一个 } 再试
    }
  }
  return null;
}

async function once(model, c, attempt = 0) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `【判据】\n${RUBRIC}\n\n【运行证据】\n${c.evidence}` },
        ],
        stream: false,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(90000),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        return once(model, c, attempt + 1);
      }
      return { verdict: null, ms, err: `HTTP ${res.status}: ${body.slice(0, 80)}` };
    }
    const j = await res.json().catch(() => null);
    const raw = String(j?.choices?.[0]?.message?.content ?? "");
    const verdict = parseVerdict(raw);
    return verdict ? { verdict, ms } : { verdict: null, ms, err: "unparsable", raw: raw.slice(0, 120) };
  } catch (e) {
    if (attempt < RETRIES) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return once(model, c, attempt + 1);
    }
    return { verdict: null, ms: Date.now() - started, err: String(e?.message ?? e).slice(0, 80) };
  }
}

const models = (process.env.CANDIDATES || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!models.length) {
  console.error("usage: CANDIDATES=model-a,model-b node probe-blueprint-judge-model.mjs");
  process.exit(2);
}

const results = {};
for (const model of models) {
  let correct = 0;
  let parsed = 0;
  let total = 0;
  let totalMs = 0;
  const detail = [];
  for (const c of CASES) {
    for (let k = 0; k < 3; k += 1) {
      const r = await once(model, c);
      total += 1;
      totalMs += r.ms;
      if (r.verdict) parsed += 1;
      if (r.verdict === c.expect) correct += 1;
      detail.push(`${c.id}:${r.verdict ?? "ERR"}${r.verdict === c.expect ? "✓" : "✗"}${r.err ? `(${r.err.slice(0, 40)})` : ""}`);
    }
  }
  results[model] = { score: `${correct}/${total}`, parsed: `${parsed}/${total}`, avgMs: Math.round(totalMs / total), detail };
}

console.log(JSON.stringify(results, null, 1));
