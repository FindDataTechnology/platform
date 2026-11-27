// 会话占用读面（rotate-cron-session-on-context-pressure 1.2）。
//
// 数据只有一个来源：回合事件行 `detail.contextUsage`（由 `engine.sessionPressure`
// 在回合落幕时写入，见 task-engine.js 的 `finishExecution` 与 server.js 的
// `recordFleetTurnEvent`）。所以这个模块是**纯整形**：不读库、不算 token、不猜窗口——
// 一行是几就报几，缺了就报缺。
//
// 为什么单独成模块而不是塞在路由里：判据要能被离线单测（路由要起 server、要 cookie、
// 要有舰队），而「哪些岗位超阈值」是这条产品线上唯一会被反复质疑的判断——它会决定
// 要不要换会话。纯函数才验得动。
//
// 两个刻意的口径：
//   · **按岗位只取最新一条带读数的回合**。旧回合的占比是历史，不是「当前会话占比」；
//     一个岗位一小时前 90%、现在 20%，它不是问题岗位。
//   · **排序按占比降序，`null` 排最后**。读面第一眼要看的正是「谁快满了」。

/** 一条回合事件 → 一条岗位读数；没有 `detail.contextUsage` 的回合返回 null。 */
function postFromEvent(event) {
  const usage = event?.detail?.contextUsage;
  if (!usage || typeof usage !== "object") return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const ratio = num(usage.ratio);
  return {
    memberId: event?.memberId ?? null,
    sessionId: event?.sessionId ?? null,
    // 这条读数出自哪一轮（回合结束时刻）——没有它，读面分不清「刚测的」与「三天前测的」。
    measuredAt: event?.endedAt ?? null,
    ratio,
    usedTokens: num(usage.usedTokens),
    // 用哪个量算的：`prompt_high_water`（每请求 prompt 高水位，与窗口可比）
    // 还是 `step_usage`（退回的单步 usage 之和）。读面必须报这个——否则同一个
    // 0.92 在两代口径下含义不同，而读的人看不出来。
    basis: typeof usage.basis === "string" ? usage.basis : null,
    inputTokens: num(usage.inputTokens),
    cacheReadTokens: num(usage.cacheReadTokens),
    contextWindow: num(usage.contextWindow),
    // 闸在同一组数字上给出的裁决（`sessionPressure().overThreshold`）。读面不自己
    // 重新比一次阈值：两处各比一次，就会出现「读面说超了、闸没换会话」这种无人能判的矛盾。
    over: usage.overThreshold === true,
  };
}

/**
 * 回合事件（每个岗位最多一条、应是各自最新的一条）→ 读面负载。
 *
 * @param {Array} events 回合事件（`deserializeTurnEvent` 的形状）
 * @param {{over?: boolean}} opts `over: true` 时只保留判定超阈值的岗位
 */
export function contextPressureFace(events = [], { over = false } = {}) {
  const posts = [];
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const post = postFromEvent(event);
    if (!post) continue;
    // 防御性去重：调用方应已按岗位取最新一条，但重复时先到的（更新的）赢。
    if (post.memberId && seen.has(post.memberId)) continue;
    if (post.memberId) seen.add(post.memberId);
    posts.push(post);
  }
  // 降序；`null`（占比读不出）沉底，但仍在列表里——「不知道」不能被排序静默丢掉。
  posts.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));
  const overCount = posts.filter((p) => p.over).length;
  return {
    // 汇总与列表用同一个分母：`over` 是全部岗位里的超阈值数，不是筛选结果的长度。
    summary: { posts: posts.length, over: overCount },
    posts: over ? posts.filter((p) => p.over) : posts,
  };
}
