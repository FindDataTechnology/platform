# Design: add-fleet-turn-events

> 前置底稿:`docs/fleet-orchestration-scale-explore.md` §六(O1 修订版)。本 change 只做 O1,不预做 O2/O3。

## D1 · 单写入点:包在 `runCronJobTurn` 收口,不进三执行器

三条触发路径(cron 节奏 / 拍板 execute-now / delegation 唤醒)在 `ctx.runCronJobTurn`(`server/cron-runner.js`)汇聚——cluster 走 `runClusterTurn`,a2a/persona 走各自执行器,manual 任务同队列同入口。事件记录器 SHALL 包在这个收口:执行前记 startedAt,执行后按返回值 `{ok, error?, interrupted?, usage?, text?}` 追加事件。不在三个执行器内部各挂一份(一处收口 = 归属/计时/状态判定只写一遍,未来 O2 turnRequest 统一时这里就是原语的落点)。

## D2 · 归属与 source 判定:sourceTag 优先,resolveAttribution 兜底

- cron 物化任务带 `sourceTag {fleetId, memberId}` → 直接归属;
- manual 任务(delegation 唤醒、拍板 execute-now、手动触发)无 sourceTag,带 `preset` → 复用 `server/fleet-reports.js` 的 `resolveAttribution(preset)` 解析 persona 在岗的岗位;
- source 推导:`trigger === "cron"` → `cron`;manual 且 `initiator` 非空(被委托发起)→ `delegation`;manual 且无 initiator → `manual`;
- 归属无果(非舰队回合)→ 不写事件,零扰动、零成本。

## D3 · 存储:fleet DB 新表 `member_turn_events`,插入时滚动裁剪

```sql
CREATE TABLE IF NOT EXISTS member_turn_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fleetId TEXT NOT NULL,
  memberId TEXT NOT NULL,
  source TEXT NOT NULL,      -- cron | manual | delegation
  status TEXT NOT NULL,      -- ok | failed | interrupted
  errorKind TEXT,            -- 分类,ok 时 null
  error TEXT,
  model TEXT,                -- persona 回合实际执行模型;a2a/无模型可空
  startedAt INTEGER NOT NULL,
  endedAt INTEGER NOT NULL,
  sessionId TEXT
);
CREATE INDEX IF NOT EXISTS idx_turn_events_member ON member_turn_events(memberId, id);
CREATE INDEX IF NOT EXISTS idx_turn_events_fleet ON member_turn_events(fleetId, status, id);
```

- 只增不改;`appendTurnEvent` 插入后裁剪该岗位超出上限(默认 200,`FLEET_TURN_EVENTS_KEEP` 可配)的最旧行——报数与拍板历史不共享此表,裁剪无涉。
- 查询函数:`listTurnEvents(memberId, {beforeId, limit})`(分页倒序,nextBefore=末条 id,同报数时间线形态)、`listFleetTurnEvents(fleetId, {status, source, limit})`、`latestTurnFor(memberId)`、`consecutiveFailures(memberId)`(从最新往回数到首个非失败事件;无失败事件为 0)。
- 聚合函数放 db 模块(与 listReports 同层),不落独立计数存储——spec 明示可从事件流聚合。

## D4 · errorKind 分类:有序模式表纯函数,other 兜底

新模块 `server/fleet-events.js`,导出 `classifyErrorKind(errorText)`——表驱动、无 IO、顺序即优先级:

| 顺序 | kind | 命中(示例,实施期按真实错误语料校准) |
|---|---|---|
| 1 | `runtime_not_ready` | runtime 还没就绪 / still starting / stayed busy / could not switch the agent |
| 2 | `timeout` | timeout / timed out / 超时 |
| 3 | `tool_permission` | permission / denied / 403 / not authorized / 工具 / 权限 |
| 4 | `model_upstream` | no runnable model / model switch failed / 429 / quota / rate / provider / 上游 / api key |
| 5 | `business_refused` | 结构化拒绝标记(escalate/refused 语义)或显式「拒绝」 |
| 6 | `other` | 兜底,不丢弃 |

- `interrupted` 状态单独存在(status 维度),不与 errorKind 混淆;
- 分类表常量导出,测试表驱动钉住每行至少一例,other 兜底钉住一例。

## D5 · 驾驶舱:成败是独立维度,派生态零改动

- `memberView` 增 `lastTurn {status, errorKind, error, endedAt, sessionId}`(来自 `latestTurnFor`)与 `consecutiveFailures`;`deriveMemberStatus` 及其派生态徽章**不动**;
- health rollup 增 `failing` = 在岗且 lastTurn.status ≠ ok 的岗位数;其余计数语义不变;
- 前端 `web/src/pages/FleetsPage.tsx`:岗位卡派生态徽章外叠加最近回合结果行(失败原因 + errorKind + 直达会话链接),连续失败 ≥3 显「连续失败」标记;从未执行过的被动岗显「尚未执行」;
- cluster 扇出岗 = 一岗一事件(任务级聚合状态),成员级细节留在会话,不放大事件粒度。

## D6 · 读面:两个端点,零凭据零正文

- `GET /api/fleets/:id/members/:mid/turns` → `{turns: [...], nextBefore}` 分页,字段同表(无凭据、无会话正文);owner 作用域同报数时间线;
- `GET /api/fleets/:id/turns?status=&source=` → 舰队级过滤(限页,不聚合正文),为架构师 pack「读态」与 O3 派发双方事件预留同一数据源。

## D7 · 测试策略

- 新增 `scripts/test-fleet-turn-events.mjs`,纯核注入式(同 fleet-reports 配方):临时库测表/裁剪/分页/聚合;表驱动测 classifyErrorKind;以注入 executor 驱动 runCronJobTurn 包装层,验证三 source 判定(cron sourceTag / manual+initiator→delegation / manual→manual)与非舰队回合零事件;
- 回归:`scripts/test-fleet-report-lane.mjs`(身份注入不受扰)与既有舰队套件全量零新增红。

## D8 · 明确不做(边界重申)

不改调度语义;不引入重试/自动降级/通知推送;events 与 reports 两条道不合并;不做 O2 turnRequest 重构;不给 events 做写面(系统记录,只增)。
