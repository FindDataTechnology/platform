// ── 裁决通道探针（fix-disclosure-gate-reachability D4）──────────────────────
//
// 为什么需要它：2026-11-11 之前，体检项只读 `MANDATE_VERDICT_TOKEN` 是否非空。
// 凭据一注入它就从 blocked 变 ok、标题写着「通道已配置」——而实测带正确凭据仍然
// 401（网关兜底挡住了机器调用）。**配了凭据 ≠ 通道能用**，这个差别只有真问一次
// 才能看见。
//
// 判据：2xx + body 是对象 + 有 `ok` 布尔 + 有 `decision` 字符串。缺一不算通——
// 「拿到了 200 但形状不对」是上游改形状的形态，不能读成可用。
//
// 失败一律 false（失败关闭）：没配 / 401 / 404 / 超时 / 非 JSON / 形状不对。
import { decideReachability } from "./mandate-verdict-probe-decision.js";

export { decideReachability };

/**
 * @param {object} input
 * @param {string} input.url        部署注入的裁决入口（网关地址）
 * @param {string} input.token      部署注入的 bearer
 * @param {string} input.owner      目标 cell 的 owner
 * @param {number} [input.timeoutMs] 默认 2500ms：体检不能自己变成慢接口
 * @param {Function} [input.fetchImpl]
 * @returns {Promise<{reachable:boolean, reason:string}>}
 */
export async function probeMandateVerdict({ url, token, owner, timeoutMs = 2500, fetchImpl } = {}) {
  if (!url || !token || !owner) return { reachable: false, reason: "not_configured" };
  const doFetch = fetchImpl ?? globalThis.fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await doFetch(`${String(url).replace(/\/+$/, "")}/api/actions/mandate-verdict`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-mandate-owner": owner,
      },
      // 探针问的是一句**必然被策略拒绝**的文本；它不会被发出去，只用来确认通道能答。
      body: JSON.stringify({ domain: "external-comms", text: "readiness probe", declaredSources: [] }),
      signal: ctl.signal,
    });
    const body = await r.json().catch(() => null);
    return decideReachability({ status: r.status, body });
  } catch (e) {
    return { reachable: false, reason: e?.name === "AbortError" ? "timeout" : "error" };
  } finally {
    clearTimeout(timer);
  }
}
