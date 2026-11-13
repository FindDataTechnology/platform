# add-spider-heal-generate

## Why

finddata 侧生成单契约已建成（fd-industry-data `source-generation-flow`，12/12 收官）：`kind=generate` 工单、出单工具 `health_new_generation_ticket.py`、`health_verify` 对生成单的 **golden 样本强制**（缺失即红）全部就位；需求书已写就在该仓 `docs/health-loop.md`「生成流」章节。萬星侧 spider-heal 却只有修复技能——三技能均以**既有单元定向 diff** 为前提，读到生成单只能转人工。本变更把生成流的萬星半边接上，让 agent 能从零起接新爬虫单元，首验收用例 `nmc-weather`（nmc.cn，纯 JSON、国内直连）。

## What Changes

- **新技能 `spider-heal-generate`**（pack 第 4 技能）：读单（kind=generate、category 必空、brief{source_urls/expectations/cadence?/notes?}）→ 从 `templates/new-source/` 起接新单元（入口 `run_<slug_snake>(limit) -> list[dict]`）→ 实现取数对齐 expectations、处理 notes 坑位 → 交付 ≥1 个 golden 样本（断言跨期稳定：避开日期与波动数值）→ 回合内 ≤3 轮运行工单 verify 声明的 `health_verify` 直至 `verdict: ok` → 分支 `gen/<slug>` 开 PR（描述附验证链证据）。
- **协议技能补一行「陈旧 working 自愈」**：巡检开始时 `working` 距 `at` >2×节奏 → 按失败回退（retry+1）——修复流同受益（既有缺口：硬停/回收留下的 working 单永远不会被重新拾起）。
- **PERSONA / RHYTHM_DO 接 kind 分诊**：kind=generate 走生成技能，修复单仍走 `spider-heal-repair`；预算句同步 **20→40min**（greenfield 回合实测面更宽，硬停撞线=白跑转人工）。
- **文档**：`docs/spider-heal-pack.md` 增生成流章节（工单形态、预算决定、演练与验收配方）。
- **部署**：pack v6 发布+重部署（`PACK_ID` 重跑 `scripts/spider-heal-pack.mjs --deploy`，secrets/通知/计费键省略即保留；runner 原地 drain，日志应见 `(1 MCP, 4 skills)`）。

硬边界（照抄修复流纪律）：不写 schedule（静默合入）、不点亮、不 merge；改动仅限目标单元目录；不逆向反爬；kind≠generate 不进此流程。

## Capabilities

### New Capabilities

（无——pack 内容运营变更，沿 `add-spider-heal-pack` 先例 `skip_specs: true`：平台 spec 行为不动，变的是 pack 内嵌的技能文本与部署参数。）

### Modified Capabilities

（无——wanxing-facade 的鉴权/准入/幂等/计量要求均不受影响；生成单走同一 SUBMIT 路径与状态机。）

## Impact

- `scripts/spider-heal-pack.mjs`：+`SKILL_GENERATE` 常量；manifest skills/resources 接线；PERSONA、RHYTHM_DO、协议技能三处小改；publish 默认预算 40min。
- `docs/spider-heal-pack.md`：生成流运营章节。
- 运营部署面：pack v6（KkCie7NlrHluo4LiKPnn0w）；不改平台代码、不改 runner env（模型保持 `deepseek-v4.1-flash`，翻车再议）。
- 外部依赖（finddata 侧，不属本变更代码面）：`reports/health-tickets/` 落盘 nmc-weather 生成单并 commit；验收前置。
- 验收完成线：drill 生成单（`drill-gen-healthz`，源=platform healthz）真回合 PASS + nmc-weather 正式单 `pr-open` 且 PR 描述含 verify 全绿证据、diff 仅 `spiders/nmc-weather/`；人审 merge 与 schedule 点亮是人工门，不在完成线内。
