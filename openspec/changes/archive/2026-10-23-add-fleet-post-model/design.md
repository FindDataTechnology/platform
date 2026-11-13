# Design: add-fleet-post-model

## Context

现状五个「选模型」的面里只有舰队岗位缺位:pack 作者(a2a serving 可钉)、部署者(服务部署配置)、对话用户(`/model`+思考档)、萬星任务(mission 四元组)都有,岗位没有。`runPersonaTurn`(`server/cron-runner.js:220`)只做 preset 归位:`switchPresetForJob(job.preset)` 每回合把运行时切到本岗 persona,模型则沿用 runtime 当前值。

一个共享 dsh runtime 服务整个 cell——`ctx.session.model` / `ctx.defaultModel` / `ctx.runtimeModel` 是 cell 级状态,模型是 dsh 会话的初始化参数(live `model/set` 能力存在时可免重启翻转,否则 restart)。`switchModelToInner`(`server/agent-session.js:278`)自带:同模型短路、流守卫、effort 兼容回落、live 翻转优先。`modelChoiceError`(`lib/agent-serving.js:374`)是现成的三闸校验(whitelist/lanes/roster,`null` 闸=开放)。

See proposal.md — Why(数百岗规模目标、成本分层动机)。

## Goals / Non-Goals

**Goals:**

- 岗位/舰队两级模型声明,长尾继承、少数覆盖、一个舰队锚;
- 回合模型语义与 preset 完全同构:每回合显式归位,不依赖上一回合残留;
- roster 漂移下的可用性:失效回落有兜底、有留痕、运营面可见;
- 账单天然正确:usage 记实际运行的模型,零新账本。

**Non-Goals**(设计级边界,proposal 非目标之外):

- 不改 `switchModelTo` / `model-selection` 的既有契约(归位链只是它的一个新调用方);
- 不合并 preset 与 model 为单次 restart(可优化项,见 Risks);
- 不做回合后「还原用户模型」——对齐 preset 现状语义(见 D6);
- 不为 cluster 岗、a2a 岗解析模型(各有其主,写面明拒)。

## Decisions

### D1 · 模型是「每回合归位」维度,不是「设了才切」

设了模型的岗位才切、未设的岗位不碰 runtime——这个直觉方案有个多岗混合漏洞:岗 A(设了 model-X)跑完 runtime 停在 X,岗 B(未设)「不碰」= 沿 X 跑,账单记 X,而 B 的语义应是 cell 默认。preset 从来没这个问题,因为 `switchPresetForJob` 每回合显式归位。所以模型照抄同一形状:**每个 persona 回合开始,把 runtime 归位到解析链结果**;未设模型的岗位 = 归位到链的下一档(而非「不碰」)。F2 的「未设模型与现状一致」由此自然成立——现状就是跑在 cell 当前模型上,归位链的链尾正是 cell 默认。

### D2 · 解析链平铺四档 + `fallback ⇒ model` 写面约束杀歧义

```
[ member.model, member.fallback_model, fleet.default_model, cell 默认 ]
  去空、去重 → 第一个在 roster 里命中的生效
  声明过但 roster 不含 → 落下一档 + blocker 留痕(指名哪档失效)
  未声明(null)     → 安静跳过
  全灭 / roster 空  → 回合如实失败
```

- **舰队级 `default_model` 身兼两职**(未声明时的默认 + 失效时的兜底):「舰队没配模型的岗位跑什么」和「模型死了落哪」必须是同一个可预期值,拆成两个旋钮会让两种岗位跑在不同模型上,没人想要。
- **岗位级 `fallback_model` 仅在 `model` 非空时可设**:若允许「无首选、有兜底」,链序出现两种都说得通的解释(兜底顶在舰队默认前还是垫在后),数百岗规模下即排障地狱。清空 `model` 时兜底还挂着 → 400 提示先清兜底。一条约束,歧义归零。
- **成本隔离是副产品**:cell 默认模型随用户聊天 `/model` 漂移,舰队锁了 `default_model` 后,岗位成本与用户聊天行为隔离——灵活性给部署者,环境漂移进不来。

### D3 · 岗位表现查,不物化进任务记录

模型解析在回合执行时从 `fleet_members`/`fleets` 现查(与 `resolveFleetIdentity` 同源同模式,fleets 侧提供 `resolveFleetModel`,cron-runner 消费)。PATCH 改模型零对账、任务引擎记录完全不动——避开给「节奏物化+幂等对账」那条需求添新对账面。反方案(把 model 塞进 cron job 记录)换来的是每 PATCH 一次任务重建/对账,不值。

### D4 · 归位实现 = 复用 `switchModelTo`,顺序在 preset 归位之后

`runPersonaTurn` 里 `switchPresetForJob` 之后调 `ctx.switchModelTo(resolved)`。两个函数各自短路(`currentPreset` / `session.model.id`),「同 persona 换模型」不会被 preset 短路吞掉;live `model/set` 存在时模型免重启翻转(preset 的 restart 仍是每次一次,与现状同级)。解析到当前模型时 `switchModelTo` 零成本短路。effort 沿用 `switchModelToInner` 的 per-provider 兼容回落,不新增岗位级 effort 概念。

### D5 · 兜底只在选型时,执行中故障不兜

roster 查不到 = 选型失效,落下一档,回合照跑。模型在 roster 里、跑起来才炸(provider 5xx/超时)= 保持现状语义:回合失败,下个 cadence 自然重试。执行中换模型重跑会踩进「重试几次、计费失败回合算谁的」的自动降级泥潭,这期不开。

### D6 · 不做回合后还原,对齐 preset 语义

单成员 cron 回合今天就不还原 preset(cluster fan-out 结束才还原 `originalPreset`),模型照抄同口径:单成员不还原、cluster fan-out 结束还原原模型+原 preset。归位照常广播 `model_changed`,UI 可见。用户聊天中被岗位回合换走模型是既有 preset 行为的同构延伸;若实际使用反馈差,「回合后还原」是纯增量(cluster 已有先例可推广)。

### D7 · 留痕三层,不新造载体

失效回落事实:① 服务端日志 + 回合执行记录(必落,任务结果可查);② 该回合存在 report 行时,回落原因进 `member_reports.blockers`(既有列);③ 账单侧天然正确——usage 记实际运行模型,按模型聚合自动把兜底花销归到兜底模型名下。诚实口径:persona 岗不调 `report_status` 时没有 report 行,此时留痕在 ①,不假装 report lane 必有行。

### D8 · 校验复用三闸,cell 侧车道闸降级开放

写面(建岗/改岗/舰队设置)走 `MODEL_ID_RE` 形状闸 + roster 闸(必做,真源 `getAvailableModels()`),车道闸走 `modelChoiceError` 的 `lanes=null` 开口语义——壹座 cell 侧当前没有 serving 部署那套计费车道面,若将来 cell 暴露车道信息再收紧,校验函数不用换。失败如实 400 并指名哪一闸。a2a 岗与集群岗设模型 400(a2a 归服务部署配置,集群岗归各成员岗位)。

### D9 · 迁移:两表各一列,ALTER TABLE 先例,回滚零动作

`fleet_members.model` / `fleet_members.fallback_model` / `fleets.default_model`,照 `decision_policy`/`source_template` 的 `try { ALTER TABLE ADD COLUMN } catch {}` 幂等模式(fleets-db 自管 schema,不走 cell 迁移账本)。回滚 = 出旧镜像,三列留空,解析链全空落到 cell 默认 = 现状行为,无需数据迁移。

### D10 · 读面给 effectiveModel(advisory)

`memberView` 返回 `model` / `fallbackModel` 原值,另按链 + 读时 roster 算 `effectiveModel`。继承链下大多数岗位声明值是 null,运营者要看的其实是「这个岗下回合会跑在什么上」;标 advisory 因为读时与回合时 roster 可能漂移。控制台岗位卡片展示 effectiveModel 与「声明已失效、正落兜底」状态——数百岗下这是巡检刚需,roster 漂移在该规模是常态而非小概率。

## Risks / Trade-offs

- [无 live `model/set` 时 preset+model 两连 restart,回合准备时间翻倍] → 长尾岗位归位结果稳定(preset 同、模型同),`switchModelTo` 短路使稳态零额外重启;两连 restart 仅发生在切换边界,秒级、巡线节奏可承受;合并为单次 `restart({agentPreset, provider, model})` 留作后续优化,不阻塞本change。
- [岗位回合换走用户聊天中的模型,用户困惑] → 与 preset 现状同构(D6),`model_changed` 广播可见;反馈差则加「回合后还原」增量。
- [effectiveModel 与实际回合模型不一致(roster 读时漂移)] → 字段明确标 advisory;失效回落有 blocker/日志留痕,以回合记录为账单与事实真源。
- [写面三闸过了、运行时 roster 已变(写时≠运行时有效)] → 这正是 D2 链存在的理由:选型时兜底 + blocker 指名,不硬失败。
- [数百岗 PATCH 批量改模型的操作面] → 舰队 `default_model` 是批量杠杆(改一处、长尾全跟随);岗位级批量编辑不在本期,留待 cockpit 迭代。

## Migration Plan

1. 出片(cell 侧 `server/` 有改动,走既有镜像链;web 控制台卡片同车或随 web 线)。
2. 部署即生效:ALTER TABLE 幂等加列;未配置任何模型字段的存量舰队解析链全空 → cell 默认,行为与现状一致。
3. 回滚:滚回旧镜像即可,三列留存无害(读面忽略、解析链视 null),无需数据回填。

## Open Questions

- cell 侧计费车道数据源:若将来 cell 暴露车道面,D8 的 lanes 闸如何取数——不影响本期(降级开放),校验函数已预留。
