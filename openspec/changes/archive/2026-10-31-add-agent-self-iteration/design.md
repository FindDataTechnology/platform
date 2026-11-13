# Design: add-agent-self-iteration

> 底稿切片⑥（终片）。已核查的在产件：fleetContext 记忆段注入（server.js:1634 memoryDigest →
> fleet-context.js:384，digest 面已上）；skill-evolution / fleet-iteration / 决策车道三条提案面；
> fd-memory MCP 写面（memory_write_page）；锚行 provenance（切片④）。

## Context

- 章程组成链：manifest agents[].memory → catalog entry（catalog.js:223 处加透传）→
  catalogEntryPersona（dsh-profile.js:1956）追加尾段 → defs diff → 子进程按既有纪律重启。
- 提案投递点：runFleetCostDigests 的 sweep 聚合完 thisWeek 后评估——数据已在手（per-member
  聚合），不新增读。
- carrier-change 的批准回调：routes/fleets.js 决策 op 处理器加一个 itemType 分支（镜像
  config-change 的回调形状但不走铸版链——成员级更新走 updateMember）。

## Goals / Non-Goals

- Goal：章程声明+组成、首个自动提案器（成本异常→carrier）、防中毒四闸钉住。
- Non-Goal：skill 演化/编排提案的自动生成（车道在，v1 只接成本异常一个源）；召回梯改造
  （已上产，只钉 spec）；distiller 改造（周报页进 L1 即达意）；多提案源并行。

## Decisions

### D1 章程 = manifest 单字段 guidance（自由文本）

`memory.guidance` ≤600 字，一条自由文本（不结构化 write/trigger/tags 三键）——章程的本体是
给 LLM 的指引，结构化键反而约束表达；spec 的「声明记什么/何时写/怎么召回」由 guidance 的
内容语义承担，写面校验只管存在性与长度。组成点在 catalogEntryPersona 的尾段（【记忆章程】
+ 原文），与 PACK_FOCUS_NOTE 同层。

- 备选被否：结构化三键（write[]/trigger/recall）——表达力倒挂，LLM 指引不需要 schema。

### D2 异常判据四条全中（阈值+样本双门）

queue_wait max ≥5min（300_000ms）× ≥3 独立日 × 样本 ≥6 回合 × carrier=cell/auto。5min 对应
「排队显著超过一回合的体感」；3 独立日滤偶发；6 回合是有价/统计意义的样本地板。建议值恒
worker + 前置说明（TASK_WORKER_MAX>0）——建议不猜测 runner（无部署证据时不硬推）。

### D3 carrier-change 批准回调不走铸版链

config-change 的铸版链（模板导出→预检→上架）面向 pack 结构；carrier 是成员级运行时配置——
回调直接 updateMember(carrier) + 既有 captureFleetFact(decision-resolved)（决策事实页自动进
f/，切片④车道）。语义与人工 PATCH carrier 完全同面（同一 updateMember，承载解析/fail-open
不变）。

### D4 去重 = 在途即跳过

评估时查该舰队 open 决策项中 itemType=carrier-change 且 detail.changes.memberId 相同者——
存在即跳过（计数器呈现）。不加时间窗（在途本身即窗口，裁决后异常仍在则下周再提）。

## Risks / Trade-offs

- [ 提案噪声 ] → 四条全中 + 在途去重双闸；决策车道自带防洪。
- [ 章程文本被注入 persona 的提示词膨胀 ] → ≤600 字硬顶；persona 尾段单段。
- [ 自动提案被批量批准的连带 ] → 每成员独立提案、独立裁决；池 cap=0 时批准的 worker 承载
  fail-open（回合照跑）——批准不是开闸，开闸仍是运维动作。

## Migration Plan

1. 滚版即生效；旧 pack 无 memory 字段零变化。
2. 验证：真机一个带章程的 agent 组成后 persona 尾段可见；提案器用验收舰队的日行构造一发
   提案→批准→carrier 生效→还原。
3. 回滚：镜像回滚即回退（manifest 字段/决策项留存无害）。

## Open Questions

- 无。
