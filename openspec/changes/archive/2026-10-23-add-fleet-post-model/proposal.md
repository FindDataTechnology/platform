# Proposal: add-fleet-post-model

## Why

舰队岗位无法指定或更换模型:`fleet_members` 没有模型列,成员回合路径(`runPersonaTurn`)只归位 persona 不碰模型,「巡线岗用便宜模型、内容岗用强模型」这种最基本的成本分层做不到——而这恰恰是舰队存在的意义(按角色分工,花不同的钱)。产品目标是让用户持续迭代管理**数百个 agents/bot 组成的舰队**,这个规模下模型配置必须是「长尾继承、少数覆盖、一个舰队锚」的形状,且 roster 漂移(模型下架)是必然常态,失效要有兜底、有留痕、可见。

需求来源:`docs/fleet-post-model-requirements.md`(柏讯内容舰队 `wire-content-fleet` 实施中发现的能力缺口,待评审,已随本轮探索更新为含舰队默认/岗位兜底的解析链方案)。与上一份 `wire-content-fleet-requirements.md` 独立。

关键定位:这是 **cell 主人的运行时决策**,与岗位已在设的节奏/KPI 槽/在岗者同级;**不触碰** pack persona 禁 `model` 的边界(那条挡的是包作者往内容包塞运行时配置,是对的)。

## What Changes

- **F1 岗位与舰队的模型字段**:岗位表加可空列 `model` 与 `fallback_model`,舰队表加可空列 `default_model`。写面(建岗/改岗/舰队设置)接受三者,`null` 清除;校验复用既有三闸(`MODEL_ID_RE` 形状 + 宿主 roster + 计费车道若可知),失败指名哪一闸。**约束**:`fallback_model` 仅在 `model` 非空时可设(杀链序歧义);清空 `model` 时若兜底还挂着一并 400。**明拒**:a2a 岗位与集群岗位设模型 → 400(a2a 的模型归服务部署配置,集群岗归各成员岗位)。
- **F2 回合归位链(与 preset 同构)**:每个 persona 成员回合开始时,把运行时模型归位到解析链的第一个 roster 命中档:`[member.model, member.fallback_model, fleet.default_model, cell 默认]`(去空去重,岗位表**现查**,不物化进任务记录)。声明过但 roster 已不含 → 回落下一档并记 blocker(指名哪档失效);未声明(null)→ 安静继承;全军覆没 → 回合如实失败。**兜底只发生在选型时**,执行中故障(provider 5xx)保持现状语义等下个 cadence。cluster 汇总回合用首个成功成员的模型。模型切换复用 `switchModelTo`(自带短路/流守卫/live `model/set` 免重启)。
- **F3 归属与可见性**:usage 记**实际运行**的模型(沿用既有 turn 记录,不新造账本,按模型聚合天然成立);`memberView` 返回 `model` / `fallbackModel`,并由服务端按链+实时 roster 计算 advisory 的 `effectiveModel`(读时与回合时 roster 可能漂移);舰队控制台岗位卡片展示生效模型,「哪些岗位声明模型已失效、正落兜底」一眼可见。

## Capabilities

### New Capabilities

(无)

### Modified Capabilities

- `agent-fleet-core`: MODIFIED 岗位一等对象与 REST 操作面两条需求 —— 岗位/舰队模型字段的读写与三闸校验、a2a/集群岗位明拒、fallback⇒model 约束;ADDED 模型解析链需求 —— 回合归位语义(四档链、失效回落记 blocker、未声明安静继承、选型时兜底、现查不物化)。
- `agent-fleet-cockpit`: MODIFIED —— 岗位卡片展示生效模型(advisory)与失效回落状态。

## Impact

- **代码**:`server/routes/fleets-db.js`(两表各加一列,照 `decision_policy` 的 ALTER TABLE 先例)、`server/routes/fleets.js`(写面校验 + `memberView` 扩展)、`server/cron-runner.js`(`runPersonaTurn` 归位链 + cluster 汇总传模型)、`server/fleet-reports.js`(blocker 留痕复用既有字段)、web 控制台岗位卡片。复用 `lib/pack-manifest.js` 的 `MODEL_ID_RE` 与 `lib/agent-serving.js` 的 `modelChoiceError`。无新依赖。
- **spec**:两份 delta(`agent-fleet-core`、`agent-fleet-cockpit`)。归档排在 `enable-wire-content-fleet`(在途 9/14)之后——两者对 `agent-fleet-core` 的 requirement 头零重叠,无排序死锁。
- **兼容性**:不带 `model` 建岗与现状逐字节一致(列可空);非舰队回合零变化;既有 `switchModelTo`/`model-selection` 契约不动。
- **非目标**(承需求文档 §四,含本轮拍板):不放开 pack persona 的 `model` 禁令;不引入岗位级 provider/凭据;不做成本超限自动降级与执行中换模型重跑;**岗位级思考档(effort)本期不做**(effort 合法性模型相关,兜底链下静态存岗位 effort 定义不清;后续若做,仅约束首选模型档);模板继续不带模型(继承让模板实例化后零配置即合理,柏讯侧零改动)。
