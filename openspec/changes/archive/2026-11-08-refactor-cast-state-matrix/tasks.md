# 任务：铸造准入判定收敛为状态表

- [x] 1.1 抽出 `server/blueprint-cast-state.js`（六个纯判定件，无 I/O）
- [x] 1.2 路由改调判定表，删除内联五刀分支（getPack 前置条件逐条不变）
- [x] 1.3 新增 `scripts/test-blueprint-cast-matrix.mjs`（13 行准入矩阵 + 5 组判定件 = 18）
- [x] 1.4 回归：blueprints 27 + trial + kind + 矩阵 18 = 61/61 绿
- [x] 1.5 biome 三文件零告警
- [x] 1.6 归档（skip_specs）
