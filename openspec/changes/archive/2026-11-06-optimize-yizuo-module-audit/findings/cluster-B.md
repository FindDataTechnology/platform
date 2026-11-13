# 簇 B 体检报告——舰队与运行（20 条 spec）

仓：/Users/chengsishi/finddata/paas。方法：逐条 spec 对照 agent-runner/、server/（fleet-*.js、routes/fleets.js、routes/fleets-db.js、blueprint-*.js）、gateway/（fleet-cells、fleet-machines、fleet-room-bridge、wanxing）、web/src（fleet 组件与页面）做只读核查。时间盒内深挖仅 B+/C/D 嫌疑。

## 一、判定总表

| # | spec | 判定 | 一句话依据 |
|---|------|------|-----------|
| 1 | agent-fleet-architect | A | 五工具/loopback 桥/驾驶舱草稿路由/成本预估/漂移拒绝全部在码（fleet-architect-mcp.js:44-94、fleet-architect.js:577-676、routes/fleets.js:894+） |
| 2 | agent-fleet-carrier | A | 三层解析、fail-open 三标记、FLEET_MAX_INFLIGHT、packId 消歧逐项落码（cron-runner.js:29-95/1361-1387、worker-slots.js:188-283、fleets-db.js:229/560） |
| 3 | agent-fleet-cockpit | A | 画布/粒子(17 处)/回放游标/五页签检查器/设计模式/兜底轮询在码（FleetCanvas.tsx、RunTimeline.tsx:1-192、routes/fleets.js:894+） |
| 4 | agent-fleet-cockpit-projection | A- | 仓内半边（overview 端点+采样器）精确对齐；要求③④⑤属萬星仓且无归属注记；line 39 乱码句 |
| 5 | agent-fleet-core | A | 审计触发器/批量端点/openDecisions/cron 记忆化/skipped 双源/就绪等待/attribution 全部落码（fleets-db.js:264-278、routes/fleets.js:2582、fleet-reconcile.js:35、cron-runner.js:133-139/1284-1300） |
| 6 | agent-fleet-decision-delegate | A- | deputy 策略/服务端强制授权/拒绝话术/recall/记忆镜像在码；executed 回填列在码（fleet-decisions.js、fleet-mcp-hints.js、fleets-db.js:133-134/946、routes/fleets.js:1907-1920） |
| 7 | agent-fleet-decision-lane | A- | escalate/过期 72h/重开/归并×N/角标 route=owner/config-change 回调在码；「舰队级队列容量」上限未见实现 |
| 8 | agent-fleet-orchestration | A- | 六边校验纯函数/supervisor 读时展开/event bot: 形状/派发双预算 env 可配在码（fleet-orchestration.js、routes/fleets.js:960-985、fleet-event-wake.js） |
| 9 | agent-fleet-report-lane | A | report_status/归属权威信号/declaredSlots/唯一注入缝（含重启恢复）/身份行逐字一致在码（fleet-mcp.js:35、fleet-context.js、fleet-turn-mandate.js） |
| 10 | agent-fleet-runs | A | run 账本 begin/end/settle/孤儿与泄漏双判定(30min 宽限)/补拍 makeup/missed 在码（fleet-runs.js:223-274） |
| 11 | agent-fleet-templates | A- | parseFleetTemplate/params 422/i18n overlay/种子守恒测试(15 份种子)/born-paused 在码；重复实例化幂等未逐行追 |
| 12 | agent-runner | A | -32005 零输出/-32012 parking/ask-answer/X-Serving-Ask/port_override 共享定义/runner_id 分片/harness 心跳/pod 模式全在码（harness/dsh.js:482、a2a.js:150/213、lib/agent-serving.js:59-77、registry.js:28-92、index.js:136-200） |
| 13 | fleet-blueprint-studio | A- | 校验链复用/三态判决/judgeSource 四态/缓存纪律/窗口顺延/judge-default 端点在码（blueprint-validate.js:149-178、blueprint-judge.js:219-270、blueprint-trial.js、routes/blueprints.js:202）；blueprint-judge.js:169 顶部注释陈旧 |
| 14 | fleet-config-overview | A | FleetConfigBar 四段聚合纯读、零新端点（FleetConfigBar.tsx:1-30） |
| 15 | fleet-machine-console | A | 名册/明细/期望态 PUT/解绑清期望/收敛四态/历史翻转写盘/steward 双门零推送全在码（gateway/fleet-machines-routes.js、fleet-machines-store.js:135-233、gateway/index.js:386-397、MachinesPage.tsx） |
| 16 | fleet-memory | **B+** | 主对象 fd-memory 服务代码在仓外（TS 仓，CELL_MEMORY_URL 指向独立部署）；本仓仅客户端缝且精确对齐；服务端 ~60% 条款本仓无代码可证、spec 无归属注记 |
| 17 | fleet-owner-iteration | A- | 提议=决策项/铸版链/批准回调不翻盘/失败环重试/digest 订阅在码（fleet-iteration.js:27-60、routes/fleets.js:1346/2457-2499、OwnerBoardStrip.tsx） |
| 18 | fleet-owner-surface | **B+** | 总览坞/占位行/装作路径(参数槽 422/born-paused/点燃)/失败分类在码；但花销 (b) sub2api 对账与 (c) 市场行按 spec 是 per-cluster，实现是账户级快照（/api/packs/billing/snapshot） |
| 19 | fleet-room-bridge | A | 订阅/解除/召唤三路由、所有权以 live sample 校验（非自有与不存在不可区分）、1h/10 条防洪、丢量标注全在码（gateway/fleet-room-bridge.js:111-160） |
| 20 | fleet-turn-memory | A- | 五类事实闭合集/own-shared 分区/metadata 一等/legacy f/ 停写/预算钳 64-2000 对齐 fd-memory 上限在码；「重放 SHALL 幂等」实现仅进程内去重 |

分布：A×11、A-×7、B+×2、C/D×0。本簇无「能力悬空」与「与代码矛盾」级问题——fd-wire 体检担心的凭据轨/实例化悬空在本簇均有着落（carrier 凭据路由、模板实例化、机器期望态门全部有实现与测试）。

## 二、展开节（B+）

### fleet-memory —— B+（主体代码域在仓外，归属注记缺失）

**spec 说什么**：整份 spec 的主语是「fd-memory 服务」（令牌五族、Grant 表、namespace 隔离、v2 磁盘迁移、reference 页型、tier 三级、/digest 渲染纪律），约 12 条 Requirement 里仅「平台缝」条款落在本仓。

**代码核查（本仓内）**：
- fd-memory 服务实现不在本仓：`servers/` 下只有 fd-health-mcp；`cell-memory.js:23` 以 `CELL_MEMORY_URL` 指向外部部署铸造令牌；`docs/agent-parallel-execution-explore.md:208-209` 明示「fd-memory src/mcp.ts」「fd-memory src/distill.ts」为另一 TS 仓的代码坐标。
- 本仓客户端缝与 spec 逐字对齐（这是好消息）：部署令牌 namespace `d/<packId>/<memberId>` 与 root_owner 监督锚（cell-memory.js:97-110 `memberTokenFor`）；project 即 memberId、`d-<packId>` 一根多 project（server/fleet-memory.js:42-50 注释明引 fd-memory 解析规则）；/digest 预算钳 64-2000 与 spec「budget ≤ 2000」镜像（server/knowledge-profile.js:34-40）；五类事实 own/shared 分派闭合集（fleet-memory.js:19-27）；legacy `f/<fleetId>` 停写保读（fleet-memory.js 头注）。
- runner 侧挂载与坐标同样对齐（agent-runner/memory-mount.js:14-35：metadata.agentId 为坐标、pod 令牌 `d/<packId>`、显示名回落）。

**偏差/风险**：
1. **归属错位（同 fd-wire 体检发现的模式）**：spec 约 2/3 的规范性条款（Grant 表 mode r|rw、v2 一次性迁移幂等、reference 页型、tier 晋降、digest 渲染顺序与保底份额）在本仓无任何代码或测试可证伪。若 fd-memory 仓漂移，本 spec 无法被本仓 CI 钉住——它声称的行为只有外部仓的测试守着。
2. spec 未写一行「本 spec 的服务端实现位于 <fd-memory 仓>」的归属注记；读者默认在本仓找实现会扑空（本次核查即如此）。

**修复建议**：spec 头部加代码域注记（服务端 → fd-memory 仓路径，平台缝客户端 → 本仓 cell-memory.js/fleet-memory.js/memory-mount.js）；或把纯服务端条款迁出本 spec。

### fleet-owner-surface —— B+（花销 (b)(c) 交付口径与 spec 分叉，诚实标注）

**spec 说什么**：「每个集群 SHALL 有花销视图」三类读数——(a) 回合/token 投影、(b) **该集群**岗位部署 key 的 sub2api 消耗周期对账值、(c) **该集群**模板/包的购买与订阅成交记。

**代码核查**：
- (a) per-fleet 落地：`GET /api/fleets/:id/spend`（routes/fleets.js:1290+）与 owner board 行内 `spend` 字段（routes/fleets.js:1284，fleets-db.js:1417 `spendProjection`——24h/7d/30d/allTime 窗口，usage 缺失如实 null）。
- (b)(c) 实际交付在**账户级**：OwnerBoardStrip.tsx:1-36 自述「花销(c)账户级粗对账 + 市场行(自己的模板成交记)」，数据源 `/api/packs/billing/snapshot`（fleet-owner-api.ts:107）与 MarketPurchase 列表；全仓无 per-fleet sub2api 对账实现（sub2api 仅出现在 turn-pricing/line-credentials 等别的面）。
- 其余条款齐：总览坞 `/api/fleets/owner/board`（routes/fleets.js:1240，ownerEmail 限域、openDecisions/failing 直达入口）、跨机休眠占位行（OwnerBoardStrip 机位占位行）、装作路径（POST /api/fleets/from-template 带 params，必填槽缺失 `params-invalid` 422 零实化痕迹 routes/fleets.js:1483-1530；born all-paused；点燃走既有启动）、失败四闸分类。

**偏差**：
1. (b)(c) 的**范围分叉**：spec 承诺 per-cluster 读数，实现是账户级快照。不误导（UI 自标「账户级粗对账」、逐路独立降级），但「每个集群 SHALL 有」的字面承诺未兑现——多集群主人无法从坞面看出单集群的钱。
2. 小疵：OwnerBoardStrip 注释把「花销账户级粗对账」标成 (c)、把市场行并在一起——字母编号与 spec 的 (b)/(c) 错位，口径叙述会让后来者对不上。

**修复建议**：二选一——spec 改口径为「(b)(c) 账户级 + (a) per-cluster」；或补 per-cluster 对账查询（fleet_runs 已有 carrier/provider/model/day 日表，按部署 key 聚合路径存在）。

## 三、A- 瑕疵清单（不展开，逐条列证）

- **agent-fleet-cockpit-projection**：spec.md:39 乱码句「柏留错位性不告警不写一次错本」（语义不可辨，疑为编辑事故）；要求③④⑤（observer EVENT_KINDS、`/api/fleet/v1/cell-fleets`、OpsView 镜像段）实现在 fd-wanxing 仓（agent-runner/fleet.js:2-6 自证「fd-wanxing services/fleet-observer」），spec 无跨仓注记。仓内半边（`GET /api/fleets/overview` routes/fleets.js:1106、采样器 env 名 `FLEET_CELL_FLEETS_SAMPLE_SECS`/`FLEET_CELL_FLEETS_ENABLE` gateway/fleet-cells.js:42-45）与 spec 逐字一致。
- **agent-fleet-decision-lane**：「每岗位每日提交数与**舰队级队列容量** SHALL 有上限」——代码只见 per-post 日上限（routes/fleets.js:1639 `daily escalation limit reached`），舰队级容量上限未找到；spec 的「队列出现新的 open 项 SHALL 按既有通知契约产生未读标记」已由 openDecisions 角标承载。
- **agent-fleet-orchestration**：派发护栏 env 名（routes/fleets.js:969 `FLEET_DISPATCH_${kind}_CAP`）与 spec「每岗每回合默认 3 / 舰队每小时默认 30 均可 env 配置」形状吻合（per-member 与 per-fleet 两键），默认值未逐字追；spec 声称 fanout rounds 为「草稿呈现层上界提示」而 validator 有 `FANOUT_ROUNDS_MAX = 3`——呈现层与校验层的分工如 spec 所述。
- **agent-fleet-templates**：种子守恒测试在码（scripts/test-fleet-templates.mjs:478-554，docs/fleet-templates/ 15 份种子）；「重复实例化幂等」未逐行追（provisioner 入口 routes/fleets.js:1503）。
- **fleet-blueprint-studio**：blueprint-judge.js:169 顶部注释仍写旧选型口径（「指定 → 否则取第一个在册模型」），与 219-270 行实现的 judgeSource 四态（blueprint/deployment/fallback + judgeFallbackReason）不一致——纯注释陈旧，代码对 spec。
- **agent-fleet-decision-delegate**：executed 回填列与 delivered 迁移在码（fleets-db.js:133-134/946）；deputy 视图与 owner 视觉区分在前端層未逐项验（OwnerBoardStrip/队列视图）。
- **fleet-owner-iteration**：链状态六值与「失败环重试」在码（fleet-iteration.js:15、routes/fleets.js:1346 409/502 分流）。
- **fleet-turn-memory**：spec「同 (fleetId, memberId, kind, ts) 重放 SHALL 幂等」——实现是进程内有界去重（fleet-memory.js:13-14 `CAPTURE_DEDUP_MAX=512`，注释自认「cross-restart replay is a non-goal」）；spec 的无条件幂等承诺强于代码。重放跨重启场景（capture 重试在重启后才发生）下会出现双观测，与 spec 场景「同一回合事实因重试被 capture 两次→仅一条」在重启窗口内不符。

## 四、本簇 P0/P1/P2 候选

**P0**：无。（无与代码矛盾、无误导实现、无凭据/权限虚位——fd-wire 曾担心的悬空类问题在本簇未复现。）

**P1**
1. fleet-memory 归属注记缺失：服务端条款 2/3 落在仓外 fd-memory 仓，本仓 CI 无法钉其行为，读者默认仓内找实现会扑空。给 spec 加代码域注记，或拆分服务端条款到 fd-memory 仓。（对齐修复成本低，防漂移收益高。）

**P2**
2. fleet-owner-surface 花销 (b)(c) 口径分叉：spec 承诺 per-cluster sub2api 对账与市场成交记，实现为账户级。改 spec 口径（承认账户级 + per-fleet token 投影）或补 per-cluster 聚合查询（member_turn_daily 已按 carrier/provider/model/day 落表，路径现成）。
3. agent-fleet-cockpit-projection：修 line 39 乱码句；为要求③④⑤加「实现在 fd-wanxing/fleet-observer」跨仓注记。
4. fleet-turn-memory 幂等条款收窄：spec 把「重放幂等」限定为同进程（或加「跨重启尽力、不承诺」的如实措辞），与实现的 fire-and-forget 去重对齐。
5. agent-fleet-decision-lane：补「舰队级队列容量」上限实现，或把该半句从 spec 删除（现只有 per-post 日上限在码）。
6. fleet-blueprint-studio：更新 blueprint-judge.js:169 顶部注释至实现的 judgeSource 四态口径（纯注释债）。
