// ── 探针判据（纯函数）────────────────────────────────────────────────────────
//
// 单独成文件是因为要能零依赖单测：探针本体要 fetch，判据不需要。
// 本项目反复栽在同一处——把"拿到 200"当"功能可用"，而 200 + 错形状才是上游
// 改形状时的常见形态（见 ledger：向量车道 200+非 JSON 静默降级）。
export function decideReachability({ status, body } = {}) {
  if (status !== 200) return { reachable: false, reason: `http_${status}` };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { reachable: false, reason: "non_json" };
  }
  if (typeof body.ok !== "boolean") return { reachable: false, reason: "shape_no_ok" };
  if (typeof body.decision !== "string" || !body.decision) {
    return { reachable: false, reason: "shape_no_decision" };
  }
  return { reachable: true, reason: "ok" };
}
