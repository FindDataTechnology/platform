# Tasks: add-fleet-turn-events

## 1. 存储层(fleets-db)

- [x] 1.1 新表 `member_turn_events`(双索引)与 `appendTurnEvent`(插入 + 按岗滚动裁剪,上限 `FLEET_TURN_EVENTS_KEEP` 默认 200);验证:超限插入滚动裁掉最旧、报数/拍板表不受影响
- [x] 1.2 查询函数 `listTurnEvents`(beforeId 分页)、`listFleetTurnEvents`(status/source 过滤)、`latestTurnFor`、`consecutiveFailures`(最新回数到首个非失败);验证:连续 3 失败→3、成功一次→0、无事件岗→0/尚未执行

## 2. 分类与记录模块(fleet-events)

- [x] 2.1 新模块 `server/fleet-events.js`:`classifyErrorKind` 有序模式表纯函数(D4 六类,other 兜底)导出分类表常量;验证:表驱动单测每类至少一例 + other 兜底例
- [x] 2.2 `recordTurnEvent` 入口:按 D2 归属(sourceTag ?? resolveAttribution)与 source 推导(trigger+initiator),归属无果静默不写;验证:三 source 判定与非舰队回合零写入

## 3. 回合收口挂点(cron-runner)

- [x] 3.1 包 `ctx.runCronJobTurn`:记 startedAt/endedAt,按返回值 `{ok,error,interrupted,usage}` 落事件(model 从 usage/会话捕获,a2a 可空;cluster 岗一岗一事件聚合态);验证:注入 executor 驱动 persona/a2a/cluster 三路径各产一事件且字段齐

## 4. 读面与驾驶舱(fleets.js + web)

- [x] 4.1 `GET /:id/members/:mid/turns`(分页 nextBefore)与 `GET /:id/turns?status=&source=`;owner 作用域;验证:分页游标、过滤命中、无凭据无正文
- [x] 4.2 `memberView` 增 `lastTurn` 与 `consecutiveFailures`,health 增 `failing` 计数,派生态推导零改动;验证:失败在岗岗入 failing、失联岗两维度并存
- [x] 4.3 `FleetsPage.tsx` 岗位卡:最近回合结果行(原因 + errorKind + 会话直达)、连续失败 ≥3 标记、被动岗「尚未执行」;验证:组件渲染断言或 stub 走查

## 5. 测试与回归

- [x] 5.1 `scripts/test-fleet-turn-events.mjs` 全绿(1.x/2.x/3.x 用例 + 三路径与零扰动)
- [x] 5.2 既有舰队套件全量回归零新增红;`openspec validate add-fleet-turn-events` 通过
- [x] 5.3 出片(server/ 有改动)与真机验收:构造一次失败回合,驾驶舱见失败状态与原因;台账补记
