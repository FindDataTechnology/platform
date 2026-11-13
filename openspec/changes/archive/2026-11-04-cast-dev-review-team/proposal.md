# cast-dev-review-team

## Why

平台的工程轴近乎空白（材料广场 197 条技能里工程类实际 3 条），而 `VoltAgent/awesome-claude-code-subagents`（MIT，26k★）的 176 个角色定义恰是这条轴的现成素材。但它的角色文件是**带手型**提示词（`tools: Read, Write, Edit, Bash`，正文命令式"运行测试/查上下文管理器"），直接搬进 pack 会得到一堆"自称能动手、实际被绑住"的说谎岗位——pack agent 是 persona-only、默认 chat 工具面。要的不是搬运，是**改铸**：把"动手干活"的角色改写成"读—判—说"的评审岗，产出评审、方案、风险清单而非代码改动。

## What Changes

- 新官方包 `packs/dev-review-team/manifest.json`：「研发评审小队」，8 个无触手评审岗——代码评审 / 安全审计 / 架构评审 / 性能分析 / 质量策略 / API 设计 / 故障诊断 / API 文档。
- 每岗 persona 含：上游身份句改写（保留专业领域与焦点）、读—判—说契约（用户贴入代码/日志/文档；不假装打开仓库/跑测试）、职责边界、按严重度分级并带证据的输出契约、逐岗上游出处（文件 + 钉版 sha）。
- 包级 `provenance`：official-adopted 记录（upstream=VoltAgent 仓、license=MIT、revision=ed74d115 钉版）；官方徽章仍由部署侧名册决定，provenance 不自我加冕。
- 基线测试钉死：无触手纪律在每岗文本里、出处字符串在、provenance 形状过校验器、`validatePackManifest` 零错。

## Capabilities

### New Capabilities

（无——复用 official-starter-agents-content 的内容基线纪律。）

### Modified Capabilities

- `official-starter-agents-content`: 新增「改铸的外部角色必须是无触手顾问」要求——persona 不得含未标注需用户执行的动作承诺，必须逐岗留上游出处与钉版。

## Impact

- **内容**：`packs/dev-review-team/manifest.json`（新）；`scripts/test-dev-review-team-pack.mjs`（新）。
- **运行时**：零代码改动。发布走既有市场发布门；本轮不发布（对外动作，另行确认）。
- **许可**：MIT 允许派生；出处 + 钉版 + 许可证记录即归属凭证。
