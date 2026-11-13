## Context

See `proposal.md` — Why. Implementation-relevant state:

- `BlueprintStudioPage.tsx`（913 行）：表单轨仅覆盖 boundary/dataSources/judgeModel（+收集库 pin、判据模型 roster 探测），其余段靠 JSON 轨；`/api/blueprints` 端到端承载草稿池/校验/试跑/铸造。
- `server/blueprint-validate.js` 已「零第二造」地组合 `validatePackManifest` + `parseFleetTemplate` + 工具面闸——Studio 团队模式复用同一校验端点即可，无需新管线。
- `add-agent-studio` D8 已声明本收编；其团队模式 v1 = 三桶卡可写 + 团队图只读。蓝图专属段不进画布，走表单（见 D1）。
- 蓝图构造师工具面（`blueprint-author-mcp.js`）产出的草稿落蓝图草稿池——通道不变，落点经 Studio 呈现。

## Goals / Non-Goals

**Goals:**
- 一个编辑面（Studio 团队模式）承载蓝图全部创作动作；旧页面退役。
- 蓝图生命周期需求零改：本 change 的 delta 只改「工作面在哪里」这一条需求。

**Non-Goals:**
- 蓝图内容形状、批准/铸造/试跑语义、v1 方言纪律、可写团队图——全部不动。

## Decisions

### D1 — 蓝图专属段走表单，不进画布
boundary/dataSources/judgeModel/monitoring/acceptance/board 在团队模式内以表单分区呈现（复用既有表单轨组件）；三桶段（agents/mcpServers/skills/fleet 成员）经三桶卡与名册。
- *Why*: 蓝图专属段是资产语义（场景边界/判据/验收），不是「桶」；硬塞进三桶卡会破坏三桶模型的清晰度。
- *Alternative rejected*: 全部段画布化——把资产语义图形化，成本高且无收益。

### D2 — 旧路由重定向而非直接删除
`BlueprintStudioPage` 路由先重定向到 Studio 团队模式（带 `?from=blueprint` 便于回滚观察），走查班确认零回归后摘除组件。
- *Why*: 两步退役给真机走查留观察窗；重定向零成本。
- *Alternative rejected*: 一次性删除——出问题时无回退路径。

### D3 — 草稿池与状态机零迁移
`blueprints.db` 的 draft/approved/cast 状态、批准流水、铸造追溯不动；Studio 只是新的读写前端。
- *Why*: 生命周期零改是本 change 的硬边界。

### D4 — NL 起草落点切到 Studio 画布
构造师工具面产出的草稿仍写蓝图草稿池（通道不变），Studio 团队模式打开草稿池条目即为画布编辑。
- *Why*: 「AI 提案、人批准」纪律不因换面而变。

## Risks / Trade-offs

- **表单轨与 JSON 轨覆盖差**（历史现状：表单只盖三段）→ Mitigation: 折叠后表单分区补齐蓝图专属段的编辑（monitoring/acceptance/board 以结构化表单或受控 JSON 编辑器呈现），双轨只读同步语义不变；回归测试钉住双轨同步。
- **与 `add-agent-studio` 的归档耦合** → Mitigation: 本 change 不触碰 `agent-studio` 能力 delta，归档先 `add-agent-studio` 后本 change；两 change 的 spec 互不重叠。
- **用户肌肉记忆**（旧入口消失）→ Mitigation: 重定向 + 入口文案指向新位置；starter 教程/文档同步更新入口描述。

## Migration Plan

1. Studio 团队模式支持蓝图文档类型（专属段表单 + 双轨）。
2. 旧路由重定向；走查班观察。
3. 摘除 `BlueprintStudioPage` 组件与死代码。
- Rollback: 摘除重定向即回到旧页面（组件未删前）；组件删除后回滚需 revert 提交（数据零风险）。

## Open Questions

- monitoring/acceptance/board 的表单化粒度（结构化控件 vs 受控 JSON 编辑器）——实现期定，不影响 spec。
