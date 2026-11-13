# add-session-to-preset

## Why

壹座 roadmap Y4 创作闭环第一刀（`docs/yizuo-platform-roadmap.md`）：非技术用户
「长期迭代自己的 AI 系统、形成独属解决方案」的自然路径**从对话开始**——他们在
会话里调教出好用法。管道后段全部就绪：预设容器（CustomPreset 已含 persona+
skills+mcpServers+tags）、发布部署流（PresetPublishFlow 四步：compose→confirm→
publish→deploy）、市场与分享。唯一缺口是**「会话→预设」的提炼入口**：调教好的
用户要存经验，必须自己跑去预设页从零手写 persona——提炼路径不存在。

## What Changes

- **会话菜单新动作「存为我的方案」**（ChatSessionMenu）→ 提炼向导
  （SessionToPresetDialog 新组件）：
  - 预填：名称=会话标题；persona=会话启动 preset（`SessionMeta.agentPreset`
    锚点解析 roster）的 persona；skills/mcpServers=该 preset 的组合快照
  - **示例提问勾选**：从会话历史（`getChatSession`）拉用户消息列表，默认勾选
    前 3 条、用户可改选——非技术用户的"好用法"最诚实的表达就是他真实问过的
    好问题
  - 保存 → 既有 CustomPreset（走既有 POST /api/agent/presets）；成功后引导
    「去发布」（既有发布流入口）
- **CustomPreset 扩可选字段 `examples?: string[]`**（≤3 条 × ≤200 字，限额对齐
  manifest serving.card.examples）：服务端校验（custom-presets.js 白名单+限额）+
  presets-api 类型 + CustomPresetsPage 编辑器增示例编辑（可选）
- **预设→pack 桥透传 examples**（preset-pack-bridge）：preset 的 examples 组装进
  draft 的 agent 条目（挂载点=serving.card.examples——校验器既支持；若桥组装时
  agent 无 serving 面，则以 design 记录的次选挂载点处理，实施时按校验器实拍定）
- spec delta：`custom-presets` MODIFIED（示例字段+提炼入口场景）+ 新能力
  `session-solution-capture`

## Capabilities

### New Capabilities

- `session-solution-capture`: 从会话提炼「我的方案」——会话菜单动作+向导
  （persona/组合快照预填+示例提问勾选）→ 落为自定义预设。

### Modified Capabilities

- `custom-presets`: 增可选 examples 字段（≤3×200 字）；其余契约不变。

## Impact

- **新增**：SessionToPresetDialog、e2e 哨兵、示例字段校验单测
- **修改**：ChatSessionMenu（+1 动作）、custom-presets.js（白名单+examples 校验）、
  presets-api.ts（类型）、CustomPresetsPage（示例编辑）、preset-pack-bridge.js
  （examples 透传）
- **复用不动**：PresetPublishFlow、发布/部署/市场链路、roster 解析
