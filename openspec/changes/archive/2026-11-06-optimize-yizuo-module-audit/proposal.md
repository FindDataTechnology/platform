# optimize-yizuo-module-audit

## Why

按模块优化战役第三线（用户拍板 2026-11-06「这一版做到能做到的最好」，壹座=核心产品条线）：壹座 253 spec / ~1684 requirement（paas 根）**从未体检过**——paas 归档 468 条中零 audit 类 change；finddata 根的柏讯试点（68 模块，P0×3 全修）与数据地基体检（86 spec 六簇进行中）已把方法学校准：五项检查+簇拆分+并行子代理+ledger/backlog 产物（方法学偏差实录见 fd-wire `optimize-wire-module-audit/design.md`）。

已知的先验漂移信号（摸底 2026-11-06，体检必须覆盖重断言）：

- Purpose TBD 占位 5 处：`upstream-concurrency`、`agent-memory-foundation`、`mcp-auth-lanes`、`platform-memory-observability`、`model-surface-budget`（`paas/openspec/specs/*/spec.md:4`）。
- `vertical-packs/spec.md:26` 仍以 `registry-groups.json` 为组闸权威——carry-registry-visibility-through-bridge（2026-11-06 归档）已把该文件降级为兜底。
- 代码已落地未归档的 change 造成的 spec 滞后（归档机追平前）。
- 私仓 biome lint 债（supply-catalog.js / test-skill-eval-groundtruth.mjs 等约 12 文件 noUnused*，快照仓 CI 52s 即红）——代码债体检顺带登记。

## What Changes

- 模块总账 `ledger.md`（253 行，簇归属+代码域初判+评级回填列）。
- 八簇并行体检，健康卡落 `findings/cluster-{A..H}.md`，五项检查带 file:line 证据（spec-代码对齐/内容正确性/接口契约/可靠性/卫生）。
- 评分 backlog `backlog.md`（P0/P1/P2）；修复另立 change，本单只体检不修码。
- 非目标：不改产品代码、不改 specs/（归档机通道除外）、不动生产（只读探针限既有配方）。

## Capabilities

### New Capabilities

（无——skip_specs: true，体检单不产能力 spec）

### Modified Capabilities

（无）
