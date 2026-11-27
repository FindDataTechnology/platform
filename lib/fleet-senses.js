// ── 感官观测（establish-agent-role-and-fitness-plane 7.2 / 7.3）──────────────
//
// 一个岗位每轮盯几个具名读面，把「这次看到了什么」写成一条可读回的观测页，
// 下一轮读回上一条与这次的差异。这是「有眼睛」的全部实现——它不引入新存储、
// 不新增 fd-memory 的 type 车道，只是 **note 页 + 一个 metadata 键**：
//
//   type: "note"                      ← fd-memory 的写面 enum 只认 note|reference
//   metadata: { kind: "observation", surface: "fd-info", at: <ISO>, source: <出处> }
//
// 为什么走 metadata 而不是新车道：服务的写面 enum 是 2026-11-15 特意收窄的
// （20+ 自造车道被拒），原注释写明「Categories go in metadata」；读面也早已
// 支持 `meta=key:value` 过滤。新开档位要破那个契约并发版客户端，收益为零。
//
// 7.3 的硬要求在这里落成**三值**而不是二值：
//   ok        取得了，且说得清变了什么
//   unchanged 取得了，确实没变（必须与「没取得」区分）
//   missing   未取得，必带原因分类（credentials / network / upstream / quota / unknown）
// 「未取得」绝不允许写成「无变化」——那是把一次失败的调用读成一个结论。

export const OBSERVATION_KIND = "observation";

/** 未取得的三类原因（与 `lib/fitness-single-arm.js` 的失败分类同一套词汇）。 */
export const MISSING_REASONS = Object.freeze(["credentials", "network", "upstream", "quota", "unknown"]);

/**
 * 从一条观测记录算出「与上一条的差异」。
 *
 * 输入是两轮的观测（上一轮、本轮），输出是给 prompt 用的一行摘要。
 * **纯函数**：不读库、不碰时钟——测试直接喂两条记录。
 */
export function diffObservations(prev, curr) {
  if (!curr) return { status: "missing", reason: "unknown", text: "本轮未产生观测（原因未知）" };
  if (curr.missing) {
    const reason = MISSING_REASONS.includes(curr.missing) ? curr.missing : "unknown";
    return {
      status: "missing",
      reason,
      // 「未取得」必须自带原因，且不得暗示「没变化」。
      text: `本轮未取得（${reason}）——不是「无变化」`,
    };
  }
  if (!prev || prev.missing) {
    return {
      status: "ok",
      text: `首次取得观测（${curr.items?.length ?? 0} 条）；无可比的上一条${prev?.missing ? `（上轮未取得：${prev.missing}）` : ""}`,
    };
  }
  const prevIds = new Set((prev.items ?? []).map((i) => i.id ?? i.title ?? JSON.stringify(i)));
  const currIds = new Set((curr.items ?? []).map((i) => i.id ?? i.title ?? JSON.stringify(i)));
  const added = [...currIds].filter((id) => !prevIds.has(id));
  const removed = [...prevIds].filter((id) => !currIds.has(id));
  if (!added.length && !removed.length) {
    return { status: "unchanged", text: `与上次相比无变化（${curr.items?.length ?? 0} 条，来源 ${curr.surface ?? "-"}）` };
  }
  const bits = [];
  if (added.length) bits.push(`新增 ${added.length} 条：${added.slice(0, 3).join("、")}`);
  if (removed.length) bits.push(`消失 ${removed.length} 条：${removed.slice(0, 3).join("、")}`);
  return { status: "ok", text: `${curr.surface ?? "来源"} 变化 —— ${bits.join("；")}` };
}

/**
 * 把一轮观测写成 fd-memory 的 note 页参数。
 *
 * 返回 `{title, body, metadata}`，由调用方用 `writeDigest(project, title, body,
 * {metadata})` 落库。**不自己发请求**：写面属于注入的客户端，便于测试与降级。
 */
export function observationPage({ surface, at, items = [], missing = null, source = null }) {
  if (!surface) throw new Error("surface is required");
  const when = at ?? new Date().toISOString();
  const meta = { kind: OBSERVATION_KIND, surface, at: when };
  if (source) meta.source = source;
  if (missing) meta.missing = MISSING_REASONS.includes(missing) ? missing : "unknown";
  const lines = missing
    ? [`观测未取得：${meta.missing}（不是「无变化」）。`, `来源：${surface}`, `时刻：${when}`]
    : [
        `来源：${surface}`,
        `时刻：${when}`,
        `条数：${items.length}`,
        ...items.slice(0, 20).map((i) => `- ${i.title ?? i.id ?? JSON.stringify(i)}${i.source ? `（出处：${i.source}）` : ""}`),
      ];
  return { title: `观测 · ${surface} · ${when.slice(0, 16).replace("T", " ")}`, body: lines.join("\n"), metadata: meta };
}

/**
 * 写一条观测，并把「写失败」如实报出来（不让它变成静默的成功）。
 * 返回 `{ok, error?}` —— 调用方据此在报数里如实标注。
 */
export async function writeObservation(client, project, observation) {
  if (!client?.writeDigest) return { ok: false, error: "memory-unavailable" };
  try {
    await client.writeDigest(project, observation.title, observation.body, { metadata: observation.metadata });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** 读回同一读面的上一条观测（按 metadata 过滤，服务端做结构化筛选）。 */
export async function readLastObservation(client, project, surface, { limit = 1 } = {}) {
  if (!client?.readPages) return null;
  const rows = await client.readPages({ project, limit, metadata: { kind: OBSERVATION_KIND, surface } });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
