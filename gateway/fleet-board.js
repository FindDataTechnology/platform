// ── 主人经营的跨机占位 (fleet-owner-surface, 跨机占位显示) ───────────────────
//
// 坞面看到的「机位行」：运气注册的每一台机位（cells-registry, durable）一
// 行——running = 在线；suspending/suspended/starting = 休眠中占位（显式行 +
// 最近流量时间, 不计入告警）；destroyed 与未注册的从不虚构。占位是读时投影
// (registry rows × 在线判定), 绝不落库 —— fleet-core「派生视图读时计算」
// 纪律在多机面上的延伸。detached registry 退化=空板（honest absence, 不是
// 错误）。
//
// 与采样的关系：fleet-cells 车道只对 live cells 采样上报（本来就是不报即
// 「本 tick 无应答」的 honest absence）；本投影补的是正面语义 — 把「注册
// 名录里存在但当前不在线」显式成行给坞面渲染。

export function ownerCellBoard({ registryDb, ownerEmail, now = Date.now() }) {
  if (!registryDb) return { v: 1, sampledAt: now, cells: [] };
  const cells = registryDb
    .all()
    .filter((row) => row.ownerEmail === ownerEmail && row.state !== "destroyed")
    .map((row) => ({
      cellId: row.cellId,
      state: row.state,
      // 占位语义: 非 running 的已注册机位显式为休眠中(占位), online=False；
      // starting/unbound 是新机位冷启段，同样如实呈现 state 但不算休眠占位。
      placeholder: row.state === "suspended" || row.state === "suspending",
      lastTrafficAt: row.lastUserTrafficAt ?? null,
      lastDutyRunAt: row.lastDutyRunAt ?? null,
      policy: row.policy,
    }));
  return { v: 1, sampledAt: now, cells };
}

export function registerOwnerCellsRoute(app, { registryDb, resolveUser, rejectUnauthenticated }) {
  app.get("/api/fleets/owner/cells", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    res.json(ownerCellBoard({ registryDb, ownerEmail: user.email }));
  });
}
