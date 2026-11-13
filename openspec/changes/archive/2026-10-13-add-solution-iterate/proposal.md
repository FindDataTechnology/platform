# add-solution-iterate

## Why

Y4 创作闭环第二刀（`docs/yizuo-platform-roadmap.md`）：用户愿景原话「**长期迭代**
自己的 AI 系统」。第一刀（add-session-to-preset）解决了从无到有——会话调教存成
方案；但方案存下之后，用户在新会话里继续调教出更好的用法时，**没有回路写回**：
只能去预设编辑器手动改，而那里看不到会话里发生了什么。「长期迭代」缺后半环。

## What Changes

SessionToPresetDialog 增**更新模式**：

- 向导头两段切换：「新建方案」（默认，现状不动）|「更新已有」
- 更新模式：下拉选择自己的自定义预设（fetchCustomPresets）→ 表单语义为
  **用本次会话的调教结果覆盖所选方案**：
  - persona 预填=会话的 persona（同新建路径，可编辑）——新调教覆盖旧设定
  - 示例提问=从会话勾选（默认前 3，同新建）——勾选结果**替换**该方案 examples
  - skills/mcpServers **保持所选方案原值不动**（组合是方案自己的资产，会话快照
    不越权重写）——UI 文案明示这一边界
- 保存走既有 PUT `/api/agent/presets/:id`（partial 语义：只送 persona+examples）；
  409 流中拒绝等既有行为不变
- spec delta：`session-solution-capture` MODIFIED（新增更新场景，携带全部既有场景）

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `session-solution-capture`: 向导支持更新已有方案——会话调教结果覆盖所选方案的
  persona 与示例提问，技能/MCP 组合保持不变。

## Impact

- **修改**：SessionToPresetDialog（模式切换+预设选择+更新路径）、五语词条增补、
  e2e 增更新路径断言
- **复用不动**：PUT 端点与校验、presets-api、发布流、编辑器
