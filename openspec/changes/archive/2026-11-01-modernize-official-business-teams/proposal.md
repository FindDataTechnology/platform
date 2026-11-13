# modernize-official-business-teams

## Why

2026-11-01 官方货架清账后剩下的 10 支业务团队（35 个岗位），是「官方示范」的其余全部内容。上一批 starter 改版只覆盖 5 支入门班组；业务团队仍是旧稿：9 支 skills 桶全空、合成/产出岗 persona 只有 178-330 字、本体建设五岗仅 64-114 字且连 report_status 契约都没有。官方货架的门面示范标准必须一致——内容配得上展示位，技能桶可执行，工具桶如实。

## What Changes

- **personas 全量重写（35 岗，≥380 字）**：统一【职责边界】【工作纪律】【输出契约】结构；逐字保留改版前的节拍、槽位与铁律（四分类、草稿优先、量级话术、32,296 口径、六源就绪、9610/1210/9710/9810、三判据、写操作永不直调、无信号是合法结论等）。
- **skills 从零补齐（10 支 × 2-3 条 = 24 条）**：程序性规范，零编造工具名；按岗位真实工具面写（wire-ops 读面、facet_market_*、law_search/law_reference、regime_timeseries/ideology_query、fd-info 五件、wanxing_* 三件、wire_artifact_* 等）。
- **工具面补缺陷**：情报舆情团队的闸位 persona 声明用 fd-sentiment 打分面，但该包未钉该 registryName → 补 fd-sentiment（五个真实工具叶）。
- **溯源与门禁**：改版前全量快照 + registry 工具真值入库；槽位名单从快照自动派生；发布脚本断言结构零 diff、既有 mcp 条目只增不改、非作者身份闸。

## Impact

- 影响包：LjTJZWqSr2AOX7WEFTVlpg（官网内容）、IVCGxpg9itGnLpHxT1khWQ（情报舆情）、8wJVZZnk369wm0oFScdecA（萬星机群运营）、ujUI1A2caCUW7TG1Z1mlEg（谦面运营）、Y99VUN6RdWs98ocK0ZAN8A（识律营销）、ZCot-b6HsnJRTTDKr_aunQ（法规追踪）、1HbpcL4LaB-csKpUQgN2Ew（政心监测）、C8wx14-4h7zJ0N19-J4NwQ（跨境电商政策盯梢）、YT87-2Axuu49I123zVYyhA（柏讯本体建设）、SWPvacoFTftfVngMMFotwQ（柏讯·产物构建）。
- 每支同 id v+1，作者不变，编队/节拍/guide/分类标签零 diff。
- 新增静态门：`scripts/test-business-teams-content-baseline.mjs`（5 条断言，联网零依赖）。
- 能力：`official-starter-agents-content`（MODIFIED + ADDED）。
