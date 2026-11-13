## Context

v4 lexicon（2026-10-30）已裁定品牌串「壹座·智能体基础设施」，但探索证实该串零渲染点；「智能体市场」作为 store 名在五语 locale 与 facet shell 文案中在用。素材广场官网（add-agent-materials-plaza）以「壹座·智能体素材广场」为品牌锚，词汇先收口。底稿：`docs/plaza-explore.md` §二。

## Goals / Non-Goals

- Goals：store 面 + 品牌串的显示层终词收口；「素材（Material）」属词入册；五语 parity 保持绿。
- Non-Goals：不改任何 i18n 键、API 路径、DB 表名、manifest 字段；不动「智能体」单位词；不在本 change 内建官网或导出管线。

## Decisions

1. **零 API 改（沿用舰队词汇两段决议先例）**：只改 locale 显示值与文档词条。备选「连键一起改」被否——键是契约，改名班永远不该滚出契约变更。
2. **MODIFIED 而非 ADD 新需求**：v4 首需求正文含品牌 bullet，若 ADD 一条与既有 bullet 矛盾的新需求会造成 spec 内部冲突；MODIFIED 带全场景超集（7 旧场景 5 改 2、新增品牌场景 1）符合归档纪律（modular-memory-specs-archive 律）。
3. **触点清单以 grep 为准**：zh 6 处（855 starterNote / 1131 desc / 1760 entries.packs / 2482 tagline / 2598 savedAs / 3671 footer）×5 语平行；facet 键住同源 locale 文件零独立改点。en 终词 "Agent Materials Plaza"；es/fr/ja 取等义词（Plaza de Materiales para Agentes / Place des Matériaux d'Agents / エージェント素材広場）。
4. **品牌串只定义不迁移**：v5 在未来渲染点（官网、页脚）定义品牌；本仓现存串中无「壹座·智能体基础设施」渲染点，无迁移债。registry 仓 landing 同口径改，registry 侧另记（不在本仓）。

## Risks / Trade-offs

- 五语等义词选择（Plaza/広場）若与既有 es/fr/ja 语感不合，走查班允许微调译文但不回改键；parity 门只查键齐不查译法。
- 「素材广场」与既有「资源库/资源集」的「资源」划界靠 CONTEXT.md Avoid 列表守住——文档改漏一处即口语回潮，tasks 里放 grep 验证。
