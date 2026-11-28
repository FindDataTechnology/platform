# 舰队编排范式扩展与规模化 explore(fleet-orchestration-scale)

> 来源:用户需求「让集群支持更多范式(开源或自建),客户通过自然语言实现数百个 agents 的编排、管理与持续迭代」,基于 `docs/fleet-orchestration-modes.md`(O1-O5 架构提案),经三轮拷问 12 问决议收口。
> 对象:paas(壹座 + 萬星)仓。
> 状态:**explore 收口,未立项**。本文是后续 OpenSpec change(暂名能力面 `agent-fleet-orchestration`)的前置底稿。
> 定位:在 O1-O5 之上做两个升级——**范式从封闭枚举升级为编导代数**,**成员从单一 persona 升级为三层承载(bot/persona/agent)**——外加壹座内的自然语言编译面(架构师 pack)。

## 一、结论先行

1. **自建薄语义层,不引开源运行时**。开源框架的范式广度来自「不枚举范式、只给一个通用组合原语」(LangGraph = 状态图,Dify = 节点 DAG,AutoGen = 消息拓扑),不是来自勤快地实现 N 个模式。我们把这层代数搬到 spec 层,执行面永远只有任务引擎 + delegation 车道,cell 隔离/计费/trace/凭据闸一个不绕。
2. **O3 的管道已经存在**。通用委托车道(`agent-delegation-tools` + `agent-delegation-a2a`)已支持 persona 目标、异步派发、结果聚合回投发起者会话、自派拒绝、a2a depth 界 1。「主管派活」从造新机制降级为给既有车道加舰队视图。
3. **单舰队 ≥50 混合成员的经济学答案是三层承载**:大量岗位零 token(T1)、少数烧 token(T2)、极少数持独立凭据(T3)。全 T2 烧钱、全 T3 进程爆炸。
4. **自然语言面 = 壹座内的架构师 pack**:编译 NL → 舰队 spec → 逐 diff 批准 → reconcile 落地;持续迭代 = 同一循环跑在活 spec 上。爆炸半径靠「每步可见」压住。

## 二、术语澄清:本文的 bot ≠ `server/bots.js`

用户语境的 **bot = 承载重量分级**(不需要独立 cell 的轻量单元),**agent = 必须独立 cell 的复杂单元**。与社聊平台机器人(`server/bots.js`,Telegram/微信 adapter)是同名不同物。社聊 bot 在本方案里的位置是**事件边的候选信号源**(第二波),不是成员类型。对外文案可用「bot = 轻量岗、agent = 独立实例岗」。

## 三、现状核查(2026-10-23 实读代码)

| 事实 | 证据 |
|---|---|
| 通用委托车道已支持 persona 目标、自派拒绝、initiator 记录 | `server/routes/delegation.js:71-80` |
| 委托结果异步聚合回投发起者会话(resultSink=caller 已实现) | `server/delegation-aggregator.js` |
| a2a 委托 depth 界 1,超界结构化拒绝 | `server/a2a-client.js:67-71` |
| 舰队层不拥有调度器;cadence 物化为任务引擎 cron,diff 引擎同步 | `server/fleet-reconcile.js` 头注释 |
| 成员回合仅暴露 `report_status` / `escalate` 两工具 | `server/fleet-mcp.js` `TOOLS` |
| 成员 targetKind = persona / cluster / a2a 三种 | `server/fleet-reconcile.js` `materializedSpec` |
| 回合失败只留在会话文本,无事件流、无连续失败计数 | `server/cron-runner.js:164/182/216/222` |
| cluster 扇出支持 `first` 与汇总两种聚合 | `server/cron-runner.js:348-365,443-465` |
| persona 岗全部跑在舰队 owner 的共享 cell(preset 切换,无 per-member 进程) | `agent-fleet-core` spec + fleet-reconcile 映射 |

## 四、成员三层模型

```
tier          承载                      隔离/凭据             成本            现状
──────────────────────────────────────────────────────────────────────────────────────
T1  skill 岗   无 persona:回合 = 执行一个  继承 owner,动作闸圈定  ~零 token        缺(新分支)
              skill/动作,确定性出 JSON
T2  persona 岗 共享 cell:pack 装进 owner   会话级隔离,凭据继承    每回合 token     ✅ 现状 persona post
              的 cell,preset 切换
T3  agent 岗   专用 cell / cluster / a2a   进程+DB+凭据级隔离     常驻运行时成本    ✅ 现状 cluster/a2a post
```

- **选层判据(一句话)**:这个岗位需要自己的凭据、自己的记忆或自己的配额吗?不需要 → 尽量往轻放;需要 → T3。
- 凭据是安全线:T1/T2 继承 owner 身份、被动作闸圈定;T3 才能持自己的凭据(同 wire-customer ref 形态)。记忆同理,T3 可挂自己的 namespace(接 fleet-memory 双 namespace 定案),T1/T2 共享 owner 的。
- T1 的实现位置:回合执行器新分支——skill 回合不走 `runPersonaTurn`,走动作闸执行 + 结果落 O1 事件。不是新运行时。
- 升层/降层 = spec 编辑 + reconcile,自然落在持续迭代循环里。升降层时的记忆/凭据迁移语义留给实施期按纪律定(见 §十三)。

## 五、编导代数(orchestration algebra)——取代 O4 封闭枚举

### 5.1 形状

```
fleet.orchestration = {
  posts:  [ {ref:"抓取", tier:T1, skill:"web.fetch"}, ... ],
  edges:  [                                        // 显式声明,每条边一个触发语义
    { from:"cron(0 9 * * *)", to:"主编",             kind:"trigger"  },
    { from:"主编",             to:"抓取",            kind:"dispatch" },   // 主管派活 → resultSink=caller
    { from:"抓取",             to:"撰稿",            kind:"handoff"  },   // 上游完成 → 下游接棒
    { from:"审校",             to:"[辩手A,辩手B,辩手C]", kind:"fanout", aggregate:"judge", rounds:2 },
    { from:"bot:tg-客服",      to:"质检",            kind:"event"    },   // 只绑已有信号源
    { from:"*",                to:"CEO",             kind:"report"   },   // 报数上行
  ],
  constraints: { maxDepth: 3, budgetPerEdgeMin: 30, spanMax: 8 }
}
```

- **边是数据,范式是图的形状**。一张图可混四种范式(上例 = 定时 + 主管 + 流水线 + 辩论 + 事件)。
- 每条边点火 = 发出一个 O2 `turnRequest`(kind 决定 source/resultSink)。turnRequest 仍是唯一执行契约;代数只是「哪些 turnRequest 能被什么产生」的声明式外壳。
- 原语集合有限:6 种边(`trigger` / `dispatch` / `handoff` / `report` / `event` / `fanout`)× 3 种聚合(`first` / `all` / `judge`);组合无限。

### 5.2 安全靠边文法,不靠枚举

- 边必须**显式声明**——可审计,不做隐式按建队顺序推断;
- 环必须有 `rounds` 上界,超界强制落 report/escalate(纪律与拍板线同构);
- `event` 边只绑**已有信号源**(社聊 bot 入站、覆盖缺口、质量快照、需求单、告警),不建消息总线;
- 多跳(链深 > 1)合法但逐跳记账:每一跳各自产 O1 事件,整链预算合计记到发起者,每跳有时长上限。链只在声明边上走,「不做多跳」防的是失控扇出,声明式 DAG 不失控——这是 `fleet-orchestration-modes.md` O4 表(「pipeline depth ≤ 节点数」)与「明确不做」一节(「depth > 1 不做」)矛盾的解法:把成本与失败归属方案补上,多跳即合法;
- 不改任务引擎调度语义,不引入第二个调度器。

### 5.3 mode 枚举降级为预制图

`mode: "supervisor"` = 一张预接线边集的语法糖。预制库可增长、以模板 pack 分发(市场 curation,与舰队模板同车道),新范式 = 新模板,不是新代码、不是新版本。自定义图是逃逸舱,不是主入口。只有出现全新原语(如 loop-until)才动引擎。

### 5.4 开源范式对照(借语义,不借引擎)

| 开源方案 | 范式来源 | 映射到本代数 |
|---|---|---|
| LangGraph | 状态图 + 条件边 | edges + constraints(环只走 capped rounds) |
| CrewAI | 层级 manager | dispatch 边 |
| CrewAI | 任务上下文 DAG | handoff 边 |
| AutoGen/AG2 | 群聊/辩论 | fanout + judge 聚合 + rounds 上限 |
| Dify / n8n | 触发器 | trigger(cron) / event(已有信号源)边 |
| Temporal | 持久执行/重试 | 远期参考;当前纪律 = 先可见后自动 |

不采其运行时的原因:任何框架进来都得绕过或重建 cell 隔离/计费/trace/凭据闸/记忆/pack 生态——那些正是本平台的差异化所在。

## 六、O1-O5 修订版

| 项 | 原提案 | 修订 |
|---|---|---|
| O1 失败事件 | 回合结果事件 + 驾驶舱可见 + 连续失败可读 | **不变,先行**(skill 回合也产事件,含 model/时长/花费) |
| O2 turnRequest | 显式回合契约 | 不变;验收从「逐字节一致」放宽为**等价 harness**(仓内既有先例);`targetRef.kind` 增加 skill(T1) |
| O3 横向派发 | 新 dispatch 工具 | 降级为 **delegation 车道舰队视图**:按岗位(memberId/ref)寻址、同 fleetId 校验、舰队级频次上限、双方产 O1 事件;**异步送达**(派发即返回,结果下回合聚合注入),绝不挂起等待 |
| O4 模式声明 | mode 封闭枚举 | 升级为**编导代数**(§五);mode = 预制图语法糖 |
| O5 黑板 | 命名槽位 | 后置;载体 = fleet-memory 双 namespace(记忆架构已定案),不新建构 |

## 七、规模护栏(单舰队 ≥50 的四道闸)

| 护栏 | 数值(初值,进 spec 可调) |
|---|---|
| T3 独立 cell 岗上限 | ≤ 8/舰,可配(env) |
| 单舰队总岗数硬顶 | ≤ 200(再大应拆多舰队) |
| 活跃 cron 岗 | > 12 验证警告;> 25 拒绝(想全定时 → 拆舰队或改 supervisor) |
| 直线下级(span) | ≤ 8,超出由架构师自动编译部门层级 |
| {{fleetContext}} 注入预算 | 按字节上限,超限走摘要(最新 + 概括),防主管上下文爆炸 |
| 环 | 必须带 rounds 上界,超界落 escalate |

## 八、自然语言面:壹座架构师 pack

- **形态**:官方 pack(可上架),工具面 = 读舰队 spec / 起草 spec 变更 / 调用与上架同源的 fleet 段预校验 / 提交 diff。写面走既有舰队写 API(ownerGate 圈定),单写者纪律不破。
- **动词范围**:结构(建/改/停/删岗、改图、改模式)+ 读态(谁没跑、谁连续失败、花了多少)+ 手动触发一轮(复用 execute-now 车道)。**不做实时指挥**——那是 supervisor 模式里 persona 自己的 dispatch 工具的地盘,架构师管编制不管作战。
- **批准面**:统一逐 diff 批准(拍板线同款);凡「新增 >5 岗 / 含 T3 / 含新 cron 节奏」的 diff,批准前必须显示成本预估区间。NL 说错一句最多生成一个待批准的 diff,零损失。
- **未知范式处理**:架构师尝试用原语组合逼近,**画出图给用户看**再确认;组合不出来才追问;永不自由发挥直接建。
- **编译选层规则**:默认选最轻能满足的层;岗位声明需要独立凭据/记忆/配额,或用户明说「单独开实例」才升 T3。
- **起步时机**:与 O1 并行——此刻后台 schedule 模式机制已够,NL 面建定时舰队今天就能用;代数到位后自然解锁 supervisor/pipeline/自定义图。

## 九、持续迭代

- 迭代闭环:自然语言 → spec 变更 → 预校验 → 逐 diff 批准 → reconcile(add/rewrite/pause/remove 既有语义)→ 运行 → O1 事件/报数摘要 → 下一轮 NL 修改。前四段与后两段机制全在,缺的是编译器(架构师 pack)与升级提示。
- **模板漂移**:实例化后模板出 v2,先做「检测到落后 + diff 预览」(驾驶舱提示),一键应用后置——「覆盖用户已手改舰队」的合并语义复杂,等真实漂移案例再定。前车之鉴:pack 已装引用滞后(41 条落后 30)是既有病灶,舰队模板会得同样的病,可见性先行。
- 活舰队导出为模板(templates change 已有导出机制)是「用-养-传」回路的出口,预制图(§5.3)作为模板内容形态随同一车道分发。

## 十、分期与排队

```
Phase 0   在途三 change 归档(enable-wire-content-fleet / add-fleet-post-model / add-fleet-template-library)
Phase 1   O1 失败事件 ‖ 架构师 pack 原型(仅 schedule 模式可用)
Phase 2   O2 turnRequest 统一(等价 harness 验收)
Phase 3   第一波代数:trigger + dispatch + handoff + report;T1 skill 岗;O3 舰队视图
Phase 4   第二波代数:event(社聊 bot 入站为第一候选信号源)+ fanout(接 cluster 扇出改造)
后置      O5 黑板(= fleet-memory namespace)、模板一键升级、debate 专项(fanout+judge 即是,不单独立项)
```

- 排队纪律:新能力面 ADDED-only(`agent-fleet-orchestration` 新立,O1 对 report-lane/cockpit 的增补也走 ADDED),避开与在途 change 的 MODIFIED 冲突(同 wire-line-board 先例)。
- debate 不单独立项:cluster 扇出 + judge 聚合已能近似「并行意见 + 一人裁决」,等真有人要多轮互驳再说。

## 十一、明确不做(继承 modes 文档并保持)

- 不做 agent 自由对话 / 全连接拓扑(边必须显式、有界、可审计);
- 不做共享消息总线 / 事件流平台(event 只接已有信号源);
- 不引入第二调度器 / 第二执行路径;
- 不做自动重试 / 自动降级(失败与成本先可见,再谈自动处置);
- 不做 NL 实时指挥(编制与作战两层职责分开);
- 不引开源编排运行时(借语义词汇,不借引擎)。

## 十二、决议日志(拷问 12 问)

| # | 问题 | 决议 |
|---|---|---|
| Q1 | 打底派 vs 面子派 | 打底派;O1 与架构师原型并行 |
| Q2 | 派发同步 vs 异步 | 异步送达(与 delegation 车道同构),绝不挂起等待 |
| Q3 | 多跳链深 | 沿声明边允许链深 ≤ 节点数,逐跳 O1 事件 + 整链预算记账 + 每跳时长上限(解 modes 文档 O4 与「不做多跳」的矛盾) |
| Q4 | 规模护栏数值 | T3 ≤8(可配)/ 总岗 ≤200 / 活跃 cron >12 警告 >25 拒绝 |
| Q5 | NL 动词范围 | 结构 + 读态 + 手动触发一轮;不做实时指挥 |
| Q6 | 批准面 | 统一逐 diff 批准;大改必显成本预估区间 |
| Q7 | v1 范式 | supervisor + pipeline(debate 不立项,event 后置)→ 已被 Q9-12 代数方案吸收 |
| Q8 | 模板升级 | 落后检测 + diff 预览先做;一键应用后置 |
| Q9 | 原语分期 | 第一波 trigger/dispatch/handoff/report;第二波 event/fanout |
| Q10 | 环纪律 | 显式 rounds 上界的有界环,超界落 escalate |
| Q11 | 预制图地位 | mode = 预制图语法糖;预制库随模板生态增长,新范式 = 新模板 |
| Q12 | 未知范式 | 原语组合逼近 + 画图给用户看 + 批准;永不自由发挥 |

另三轮对齐:单舰队 ≥50 混合成员是需求下限;bot/agent = 承载重量分级(§二);NL 面在壹座内。

## 十三、留给实施期的小决策(已授权按纪律自定)

- T3 升降层时的记忆/凭据迁移语义(等首批真实案例);
- 依赖边/handoff 的 NL 语法(「A 完成后交给 B」的措辞集);
- 等价 harness 的具体形状(复用仓内既有先例);
- 预制图初始集(除 schedule/supervisor/pipeline 外是否首发更多);
- {{fleetContext}} 注入预算的具体字节数与摘要算法。

## 十四、参考落点(在 modes 文档 §九之上增补)

```
server/routes/delegation.js     O3 舰队视图的挂点(persona 目标分支已存在)
server/delegation-aggregator.js resultSink=caller 的既有实现,舰队派发复用
server/cron-runner.js           T1 skill 回合分支 + O1 事件挂点
server/fleet-reconcile.js       代数 spec → 任务引擎物化的 diff 引擎扩边
server/fleet-mcp.js             dispatch 工具的舰队面(若不走通用 delegation 工具)
server/routes/fleets.js         orchestration 段写面 + 图校验
server/fleet-template.js        预制图 = 模板内容形态
```

## 十五、词汇决议(2026-10-24,运营者框架,v2 既定方向)

> 背景:员工框架(排班/汇报/组织树)短期省理解成本,但隐含「组织结构为人设计、agent 填人的坑」的假设——与「人指挥一群 agent」的方向相反,长期制造歧义。用户 2026-10-24 定向:命名重要,值得多花精力。系统本体本就是「带人工闸门的自动化工厂」(trigger/turn/outcome/gate/edge),员工词汇只是皮肤;产品自身已从组织(树)漂向编排(边),词汇随行。

### 决议词表(v2 一次性换到位)

| 现在(员工皮) | v2(运营者框架) | 说明 |
|---|---|---|
| 排班 | **定时运行** | 字段名;「触发」留给整个家族(cron/事件/派发/接棒);与编排边徽章「定时」对齐 |
| 汇报 | **产出**(名词)/ **交付**(动作) | 按钮「立即交付」;report_status 等 API 键不动 |
| 接棒 | **流转** | 工作流向下站;派发/扇出/事件已是运营词不动 |
| 组织树 | **结构视图**(降级) | 树仍承载 {{fleetContext}} 注入路径——**只降级命名不删功能**,边图升主位 |
| 保留 | 审批/岗位/舰队/驾驶舱/五状态词/回合/待命/空缺 | 已中性或运营词;审批=人工闸门永恒 |

### 原则(防翻车)

1. **词性分工**:状态=机器名词(运行/暂停/超时未报),动作=人话动词(交付/确认/派发)——防运营者框架滑成工程师黑话。
2. **皮肤不动物体**:i18n 键/API/存储字段零改,只动显示词(两次改名均如此)。
3. **术语卡双语对照**:员工词×运营词并排,让存量用户自己迁移;新界面一律运营框架。
4. **课程随车**:v2 落地时课程三载体(canonical/CMS/官网)同词表重写,一次性。

### 迁移时机

不立刻第三轮翻词(三天两套已到用户承受上限);随**驾驶舱 v2**(边图主位+术语卡)一次到位。2026-10-24 已落地的员工框架改名(排班/汇报/审批)作为 v2 前的过渡皮肤,不是终点。

### §十五·补记:v2 提前执行(2026-10-24 当日)

原计划「随驾驶舱 v2 一次到位」,当日即执行——因为发现员工框架过渡皮肤(76fdc926)**尚未随镜像上产**,线上用户仍见最初词汇,此刻直跳终词=用户只经历一次可见变化,翻词成本为零。落地:第二段词汇五语言(定时运行/产出×交付/流转)、术语卡(旧词×现行词九行对照,collapsible)、隐式边聚合(56 行→1 行「全员互可派发 N 对」,§15.21 UX 发现清账)、树降级为「结构视图」collapsible(功能不删,{{fleetContext}} 注入照旧)。课程第三轮=终轮措辞随车(canonical/CMS/官网 1dc6d3a 已滚,线上验证:定时运行×7/产出×4/接棒绝迹)。paas UI 侧待下一班镜像随车。
