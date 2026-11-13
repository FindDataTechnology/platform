# Design: add-fleet-memory-anchors

> 底稿切片④。现状核查：`server/fleet-memory.js`（五类事实→f/，fire-and-forget）、
> `server.js:1253` captureFleetTurnFact（无 meta）、swap 事实在清史**之后**（routes/fleets.js:2825）、
> 日行计量列（切片②）、cost 列（切片③）全在产。

## Context

- 捕获缝：`ctx.recordFleetTurnEvent(job, outcome, meta)` → `captureFleetTurnFact(job, outcome)`
  ——meta（ledgerTurn/model）已在手但没传下去；锚行只差这一步。
- 末次回合锚源：fleet db 的 `listTurnEvents(memberId, {limit:1})`（导出在案）。
- 周报读源：`member_turn_daily`（fleet 维度直查），成本=四分量 cost 列合计（有价样本口径）。

## Goals / Non-Goals

- Goal：锚行、swap 交接锚、周报页——记忆页与台账一跳互查。
- Non-Goal：runner 侧 L0 镜像 f/（本就不该——分流钉死）、handoff claim-once 工具面（agent 自写，
  Q11 纪律不变；本片只让平台侧事实页带交接信息）、周报的 HTTP 面（纯记忆页）。

## Decisions

### D1 锚行是正文头一行，不是 frontmatter

fd-memory 页面是纯 markdown（L0/L1 管道按文本读）；锚行格式 `[turn turn_id=… run_id=… carrier=…
model=… tokens=in/out/billed status=…]`——蒸馏器与正则读都友好，frontmatter 属 OKF 格式层不动。

### D2 swap 重排：锚先于清

现状顺序 清史→updateMember→swap 事实。重排为 **读末次回合→落 swap 事实（带离任锚）→清史→
updateMember→reconcile**。事实走外部 HTTP（fire-and-forget），与镜像会话清空零耦合——重排纯粹
让锚能读到清史前的末次回合。active 回合在飞时的 409 拒绝语义不变（清史分支原样）。

### D3 周报的「周」与触发

UTC ISO 周（周一 00:00 为界）；6h 步进检查「本周是否已写」，进程内存 lastWeekByFleet 记账
（重启可能重写一次——记忆页永不删，重复页无害且诚实）。movers 口径：cost 本周/上周 ≥2× 且
本周 cost ≥ $0.001（滤噪），或 queue_wait_max 环比 ≥+50% 且本周 max ≥ 30s。无上周样本写
「无对照」。

### D4 captureFleetTurnFact 签名扩展

`(job, outcome)` → `(job, outcome, meta)`；server.js 的包装把 meta 透传（model/ledgerTurn 在内）。
旧调用（cron-runner 两处）已传 meta——零改动。outcome.metering 的 carrier/queueWait 本就在
outcome 上——锚直接读。

## Risks / Trade-offs

- [ 周报重复页（重启重写）] → 记忆永不删页纪律本就容忍重复观测；蒸馏器按时间取最新。
- [ tokens 三列和的口径 ] → usage_input+cached+write（切片② D4 同源）；cached 列 NULL 时按
  input+output 记并如实缺省 billed 段——不猜。
- [ 周报对超大舰队的行数 ] → 每成员一行、按 cost 降序截断前 12 行 + movers 单列——页面紧凑。

## Migration Plan

滚版即生效（无迁移）；回滚镜像即回退，已落记忆页留存（永不删）。

## Open Questions

- 无。
