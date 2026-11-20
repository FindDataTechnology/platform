// ── Artifact output contract, derived from the CaaS authority ───────────────
//
// openspec: add-caas-delivery-contract 6.1.
//
// This text used to be a literal inside server/agent-session.js. That made the
// form vocabulary exist in TWO places: the CaaS authority (lib/caas-forms.json)
// and this prose. Adding a form meant editing the JSON *and* remembering to
// reword the sentence — and nothing would fail if you forgot. Exactly the
// "second copy that silently drifts" defect the contract exists to prevent.
//
// So the sentence is DERIVED: the form names/labels come from the authority,
// and only the platform-specific delivery rules (which form maps to which
// renderer, the data:-URI ban, the library-save discipline) are written here.
// Those rules are genuinely this platform's, not the authority's.
//
// Keep it short — the spec requires a "baseline-skill sized instruction layer",
// not a prompting style guide. If you add a paragraph here, you are probably
// writing documentation that belongs elsewhere.

import { CAAS, FORMS } from "./caas-envelope.js";

/** Chinese labels in the order the authority lists them. */
function formLabels() {
  return FORMS.map((f) => CAAS.forms[f]?.label_zh ?? f);
}

/**
 * Compose the artifact output contract for one persona.
 *
 * `agentName` / `agentDescription` are the persona identity; the contract is
 * appended to them rather than replacing them, because the identity is what
 * makes the turn answer AS the named agent.
 */
export function composeArtifactContract({ agentName, agentDescription } = {}) {
  const labels = formLabels();
  const chart = CAAS.forms.chart?.label_zh ?? "图表";
  const file = CAAS.forms.file?.label_zh ?? "文件";

  const identity = agentDescription ? `你是「${agentName}」——${agentDescription}。` : "";
  return (
    `${identity}回答用中文（除非用户使用其他语言），结论先行；没有工具可用时如实说明，不要编造数据或结论。` +
    `平台产物契约：${chart}一律用 \`\`\`echarts 围栏输出 JSON option（不用 mermaid），平台会渲染并自动存入资源库；` +
    `如引用产出${file}，用工作区相对路径 markdown 链接；禁用 data: URI 链接；` +
    `不要声称平台无法渲染或交付你的产物。` +
    // The available-form vocabulary is stated explicitly so the model can see
    // what this platform actually delivers — and so a reader can tell at a
    // glance whether the authority and this sentence still agree.
    `（本平台可交付形态：${labels.join(" / ")}）`
  );
}

/** The bare contract text, with no persona identity — for tests and reuse. */
export function artifactContractText() {
  return composeArtifactContract({});
}
