// ── 5-day window & cursor discipline ────────────────────────────────────────
//
// 腾讯只保留 5 天会话内容（官方 FAQ 91552 / 91774：拉取不能超过 5 天，需要全量就必须定期拉）。
// 于是"拉取器是否活着"不是运维细节，是产品指标：
//
//   滞后 > 3 天  → 告警
//   滞后 > 5 天  → 永久丢失，且**不得**因为后续拉取成功而被改写回"正常"
//
// 这个模块只做三件纯计算，不碰 DB、不碰网络，所以可以逐格断言：
//   1. 游标只进不退（`advanceCursor`）；
//   2. "最后检查时间"与"最新消息时间"是两个字段，不能混用（`evaluateLag`）；
//   3. 丢失区间一旦产生就留在账上（`recordLoss` 的语义由调用方持久化）。

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const WARN_DAYS = 3;
export const HARD_LIMIT_DAYS = 5;

/**
 * 推进游标。**只增不减**：乱序或重放都不能把 seq 拉回去，
 * 否则会重复入库或漏掉区间。
 */
export function advanceCursor(state, { seq, now, pulled, success = true }) {
  const next = { ...state };
  const incoming = Number(seq);
  const current = Number(state?.seq ?? 0);
  next.seq = Number.isFinite(incoming) ? Math.max(current, incoming) : current;

  // 检查时间永远前进：断流期间也要推进，否则恢复后无法判断"停了多久"。
  next.lastCheckedAt = Math.max(Number(state?.lastCheckedAt ?? 0), Number(now ?? 0));

  // 成功拉取的时刻：只有**没有异常**的周期才推进。
  //
  // 它和 lastCheckedAt 是两件事，不能合并：拉取失败时 lastCheckedAt 照样前进
  // （"我们试过"要留痕），所以它证明不了"拿到过"；反过来 lastMessageAt 也不行——
  // 没人说话不等于丢了消息。滞后水位只认这一列。
  if (success) {
    next.lastSuccessAt = Math.max(Number(state?.lastSuccessAt ?? 0), Number(now ?? 0));
  } else {
    next.lastSuccessAt = Number(state?.lastSuccessAt ?? 0);
  }

  if (Number(pulled) > 0) {
    next.lastMessageAt = Math.max(Number(state?.lastMessageAt ?? 0), Number(now ?? 0));
  } else {
    next.lastMessageAt = Number(state?.lastMessageAt ?? 0);
  }
  return next;
}

/**
 * 滞后判定。
 *
 * 水位取 **`lastSuccessAt`（最后一次成功拉取的时刻）**，不是 `lastMessageAt`，
 * 也不是 `lastCheckedAt`：
 *
 *   • `lastCheckedAt` 在拉取**失败**时也前进（"我们试过"），用它算滞后会永远显示健康
 *     ——真断流被洗白，这正是要避免的假绿。
 *   • `lastMessageAt` 是"最后一条消息的时间"。安静通道（客服号几天没人说话、群里放假）
 *     在每一轮拉取都成功的情况下，它照样会慢慢变旧，于是被记成"缺口不可补偿"——
 *     这是会写进合规账本的假红。
 *
 * 只有"成功拉取"能证明"上游答复过没有新的"。窗口长度必须可传：会话存档保留 5 天、
 * 微信客服只保留 3 天，两个通道复用同一个判定，阈值各自传（`warnDays` / `hardLimitDays`）。
 */
export function evaluateLag({
  lastMessageAt,
  lastCheckedAt,
  lastSuccessAt,
  now,
  warnDays = WARN_DAYS,
  hardLimitDays = HARD_LIMIT_DAYS,
}) {
  const t = Number(now);
  const msg = Number(lastMessageAt ?? 0);
  const checked = Number(lastCheckedAt ?? 0);
  const ok = Number(lastSuccessAt ?? 0);

  const hoursSinceCheck =
    checked > 0 ? Math.max(0, (t - checked) / 3_600_000) : null;
  // 距最后一次**成功**拉取。窗口判据只认它。
  const hoursSinceSuccess = ok > 0 ? Math.max(0, (t - ok) / 3_600_000) : null;
  // 距最后一条消息：只作为诊断值返回，不参与判定。
  const hoursSinceMessage = msg > 0 ? Math.max(0, (t - msg) / 3_600_000) : null;

  let level = "ok";
  let reason = "最后一次成功拉取在窗口内";

  if (!checked) {
    level = "never_checked";
    reason = "从未成功检查：通道未运行或未就绪";
  } else if (hoursSinceSuccess === null) {
    // 老库升级后还没记录过成功时刻：宁可说"不知道"，也不能拿最后一条消息时间
    // 去猜 —— 那个口径会把手脚干净的安静通道记成丢失。
    level = "never_checked";
    reason = "尚未记录成功拉取的时刻（老库升级后需先跑通一轮）";
  } else {
    const days = hoursSinceSuccess / 24;
    if (days > hardLimitDays) {
      level = "lost";
      reason = `距最后一次成功拉取 ${days.toFixed(1)} 天，超过官方 ${hardLimitDays} 天保留窗口，缺口感不可补偿`;
    } else if (days > warnDays) {
      level = "warn";
      reason = `距最后一次成功拉取 ${days.toFixed(1)} 天，超过 ${warnDays} 天告警线`;
    } else if (hoursSinceSuccess > 24) {
      // 还在窗口内、但已经一天没成功拉过：告警线之前先报"停滞"。
      level = "stalled";
      reason = `拉取器已 ${hoursSinceSuccess.toFixed(1)} 小时没有成功拉取`;
    }
  }

  return {
    level,
    reason,
    hoursSinceMessage,
    hoursSinceCheck,
    hoursSinceSuccess,
    days: hoursSinceSuccess === null ? null : hoursSinceSuccess / 24,
  };
}

/**
 * 记录一段不可补偿的丢失。
 *
 * 语义是"记账"，不是"状态"：后续拉取成功**不得**删除这条记录。
 * 规格里的原话是「MUST NOT 被后续成功拉取清除」，这里把这条约束做成数据结构——
 * 调用方每次只能 append，没有 delete 路径。
 */
export function recordLoss(losses, { fromTs, toTs, seats = [], detectedAt }) {
  const list = Array.isArray(losses) ? losses.slice() : [];
  const from = Number(fromTs);
  const to = Number(toTs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new Error(`丢失区间非法：from=${fromTs} to=${toTs}`);
  }
  // 与既有区间合并，避免同一次断流产生几十条相邻碎片。
  for (const item of list) {
    if (to >= item.fromTs && from <= item.toTs) {
      item.fromTs = Math.min(item.fromTs, from);
      item.toTs = Math.max(item.toTs, to);
      item.seats = [...new Set([...(item.seats || []), ...seats])];
      item.detectedAt = Math.min(item.detectedAt || detectedAt, detectedAt);
      return list;
    }
  }
  list.push({ fromTs: from, toTs: to, seats: [...seats], detectedAt: Number(detectedAt ?? Date.now()) });
  return list;
}

/** 汇总给巡检面：丢失区间总时长与条数，永不因新数据而缩小。 */
export function lossSummary(losses) {
  const list = Array.isArray(losses) ? losses : [];
  let ms = 0;
  for (const item of list) ms += Math.max(0, Number(item.toTs) - Number(item.fromTs));
  return { count: list.length, totalHours: ms / 3_600_000, unrecoverable: list.length > 0 };
}
