// ── Ruling evidence: 判定引用而非自由文本 ──────────────────────────────────
// (openspec bind-decision-verdict-ref-and-turn-artifacts §1/§2)
//
// 拍板行 (decision_items.ruling_evidence) 原先只存一段自由文本。那使「这个批准
// 是凭什么做的」无法被机制复核：结论标识、尺子 digest、结局都被揉进一句话里，
// 读面只能切片展示。本模块给它一个可解析的形状，分两种写法：
//
//   • 有判定引用：存 JSON `{ verdict_ref, ruler_digest, outcome, text }`。
//   • 无判定引用：人依据判断直接裁定，没有评测结论 —— 仍存 JSON，但显式记
//     `verdict_ref: null` + `kind: "no-verdict-ref"`，读作「无判定引用」，
//     MUST NOT 被读成「判定失败」或「空依据」（spect: 人拍板不要求有判定）。
//   • 纯文本（存量行）：写入点不带宽时逐字节存原文，读面 kind 判为 "text"，
//     与上面两种结构化写法都可区分，且不把旧行读成「无依据」。
//
// 关键诚实边界：null 与空集不同。`verdict_ref: null` 是「确认没有判定引用」，
// 是事实；「取不到这一行」是另一种事实，由调用方（读面）另行表达，不在本模块。

const MAX_TEXT = 2000;
const MAX_REF = 200;
const MAX_DIGEST = 200;

function clip(v, n) {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v.trim() : String(v).trim();
  return s ? s.slice(0, n) : null;
}

/**
 * 把可选的判定引用输入规范化成三件套（结论标识 + 尺子 digest + 结局），或 null。
 * 接受 camelCase 与 snake_case 两种键（通道来自 MCP 工具与 HTTP body 两处）。
 * 任一必填缺省即整体判为「无有效引用」——半截身份是读面无法复核的形状，宁可不记。
 */
export function normalizeVerdictRef(input) {
  if (!input || typeof input !== "object") return null;
  const verdictRef = clip(input.verdictRef ?? input.verdict_ref ?? input.runId ?? input.run_id, MAX_REF);
  const rulerDigest = clip(input.rulerDigest ?? input.ruler_digest, MAX_DIGEST);
  const outcome = clip(input.outcome, 40);
  // 结论标识是「回读该结论」的钥匙，缺它整组无意义。
  if (!verdictRef) return null;
  return { verdictRef, rulerDigest, outcome };
}

/**
 * 写入侧的单一构造点。返回要落进 `ruling_evidence` 的字符串：
 *   • 有 verdictRef → JSON（含 text 说明）
 *   • 无 verdictRef 但调用方声明这是「人直接裁定」（explicitNoVerdict）→ JSON 记
 *     `kind: "no-verdict-ref"`（诚实形状，不是失败）
 *   • 其余 → 原文（逐字节，与改动前一致）
 *
 * `evidence` 是自由文本说明（旧调用方的 evidence/note）。`noVerdictMarker`
 * 为真时即使 evidence 为空也写结构化 JSON —— 那正是「人拍板无判定」需要留痕的场景。
 */
export function buildRulingEvidence({ verdictRef = null, evidence = null, noVerdictMarker = false } = {}) {
  const ref = normalizeVerdictRef(verdictRef);
  const text = clip(evidence, MAX_TEXT);
  if (ref) {
    return JSON.stringify({ kind: "verdict", verdict_ref: ref.verdictRef, ruler_digest: ref.rulerDigest, outcome: ref.outcome, text });
  }
  if (noVerdictMarker) {
    return JSON.stringify({ kind: "no-verdict-ref", verdict_ref: null, ruler_digest: null, outcome: null, text });
  }
  return typeof evidence === "string" ? evidence.slice(0, MAX_TEXT) : null;
}

/**
 * 读侧：把列值解析成 `{ verdictRef, rulerDigest, outcome, text, kind }`。
 * kind ∈ "verdict" | "no-verdict-ref" | "text" | null（无值）。
 *
 * 判别顺序刻意：先试 JSON——一棵恰好长得像 JSON 的纯文本不该被猜成结构化，故只有
 * 解析成功且带本模块的 `kind` 标记时才当结构化读；否则原文就是 text。存量纯文本行
 * 因此读成 `{kind:"text", text:<原文>}`，text 与改动前逐字节一致。
 */
export function parseRulingEvidence(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return { verdictRef: null, rulerDigest: null, outcome: null, text: null, kind: null };
  }
  if (typeof raw === "string") {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (parsed && typeof parsed === "object" && (parsed.kind === "verdict" || parsed.kind === "no-verdict-ref")) {
      return {
        verdictRef: parsed.verdict_ref ?? null,
        rulerDigest: parsed.ruler_digest ?? null,
        outcome: parsed.outcome ?? null,
        text: parsed.text ?? null,
        kind: parsed.kind,
      };
    }
    // 纯文本：原文即 text，逐字节保留。
    return { verdictRef: null, rulerDigest: null, outcome: null, text: raw, kind: "text" };
  }
  // A non-string column value is not a shape this writer produces; read it as
  // unrecorded rather than guessing.
  return { verdictRef: null, rulerDigest: null, outcome: null, text: null, kind: null };
}
