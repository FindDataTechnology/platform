# 簇 H-b 健康卡 — 其余 32 模块（第二遍指针卡）

审计人：主会话收口 · 日期 2026-11-06 · paas HEAD `72947b040`

## 为什么是指针卡

本遍（optimize-paas-module-audit，十簇 G1–G10，267 模块）与同日归档的第一遍（`archive/2026-11-06-optimize-yizuo-module-audit`，八簇 A–H，逐条体检）**范围重合**。收口核查发现：这 32 条在第一遍已逐条覆盖并回填评级（证据卡在 `archive/2026-11-06-optimize-yizuo-module-audit/findings/cluster-{A,B,C,D,E,F,H1,H2}.md`）。为免重复劳动与双份口径，本卡按去重原则：①从第一遍 ledger 回填本遍评级；②对第一遍的争议/当日已修条目做**抽样复核**（下表「复核注记」列）。

## 32 条评级与证据指针

| # | 模块 | 评级 | 第一遍证据 | 复核注记（本遍） |
|---|------|------|-----------|------------------|
| 1 | bundle-manifest | A | 第一遍 ledger（reqs=2） | — |
| 2 | connection-center | A | 同上（reqs=4） | — |
| 3 | connector-credentials | A | 同上（reqs=8） | — |
| 4 | credential-file-format | A | 同上（reqs=3） | — |
| 5 | deployment-branding | A | 同上（reqs=5） | — |
| 6 | device-pairing-auth | A- | 同上（reqs=6） | — |
| 7 | facet-editor-cli | B | 同上（reqs=6） | 第一遍 P1-13（Purpose 与 Requirement 矛盾）；Purpose 已见回填 |
| 8 | facet-market-credentials | A | 同上（reqs=6） | — |
| 9 | facet-platform | A- | 同上（reqs=23） | — |
| 10 | studio-ai-drafting | A- | 同上（reqs=3） | ⚠️ 并发迁移中：add-supply-studio-migration 在册（W2 迁入代码面），本评级按迁移前快照 |
| 11 | supply-annotation-overlay | A | 同上（reqs=8） | ⚠️ 并发迁移中：add-supply-store-unification / add-supply-studio-migration |
| 12 | supply-catalog | A- | 同上（reqs=5） | ⚠️ 并发迁移中：同上（SUPPLY_STORE_CATALOG 二翻在产，c79cdea） |
| 13 | system-status-dashboard | A- | 同上（reqs=5） | — |
| 14 | task-engine | A- | 同上（reqs=9） | ✅ 本遍抽验：Purpose 完整、9 条 Requirement 与 `server/task-engine.js` 在位一致 |
| 15 | tenant-cell-runtime | A | 同上（reqs=5） | 第一遍 stale 注记（35 天）= align 回写导致的 spec 反超，语义无恙（见 backlog N-14） |
| 16 | test-process-hygiene | A- | 同上（reqs=4） | 与本遍实测互印：`scripts/lib/test-server.mjs` 四机制在位，chat e2e 跑完零孤儿进程 |
| 17 | theming | A- | 同上（reqs=6） | — |
| 18 | tool-description-enrichment | A- | 同上（reqs=5） | — |
| 19 | tool-discovery | A- | 同上（reqs=6） | — |
| 20 | tool-use-rendering | A- | 同上（reqs=5） | — |
| 21 | turn-dispatch | A | 同上（reqs=9） | — |
| 22 | turn-tracing | A | 同上（reqs=5） | — |
| 23 | upstream-concurrency | B+ | 同上（reqs=3） | ✅ 本遍抽验：Purpose 已回填（第一遍 P1-8 的 TBD 已销），且已写明「实现载体=仓外 sub2api fork」（P1-7 归属注记已落）——**可上调 A-**，本表保守留 B+ 待下轮 |
| 24 | user-runtime-bindings | A- | 同上（reqs=6） | 第一遍 stale 注记（50 天）= 回写反超（见 backlog N-14） |
| 25 | vendor-server-onboarding | A | 同上（reqs=4） | 第一遍另记：期望态模块，实现待落地 |
| 26 | vertical-packs | C | 同上（reqs=5） | ✅ 本遍抽验：Purpose 已补全、权威指针已改（第一遍 P1-4 由 align 批 90acfaf10 修复）——**可上调 B**，本表保守留 C 待下轮 |
| 27 | virtual-mcp-servers | B | 同上（reqs=2） | 第一遍记跨仓（registry 仓）归属无注记（P1-7 族） |
| 28 | voice-lane | A- | 同上（reqs=6） | — |
| 29 | worker-pool | A | 同上（reqs=7） | — |
| 30 | zhiyu-im-bridge | A- | 同上（reqs=6） | 第一遍 P1-11：spec REST 路径笔误（/api/zhiyu/im-bridge vs 代码 /api/zhiyu-im-bridge），待改 |
| 31 | zhiyu-room | A | 同上（reqs=11） | — |
| 32 | zhiyu-widget | A | 同上（reqs=9） | — |

## 簇摘要

**评级分布：A×14 · A-×14 · B×2 · B+×1 · C×1（共 32）**——与第一遍「无系统性漂移、C/D 合计 2%」的结论一致。两条可上调候选（upstream-concurrency→A-、vertical-packs→B）均因第一遍 backlog 条目已被 align 批修复，下轮复评时上调。

**需盯的两件事**：
1. **三条 supply/studio 模块正在并发迁移**（studio-ai-drafting / supply-annotation-overlay / supply-catalog）：本评级是迁移前快照，W2 两个 change 归档后应复评一次。
2. **zhiyu-im-bridge REST 路径笔误**（第一遍 P1-11）仍在，属纯 spec 文本改，随下一 align 批销账。
