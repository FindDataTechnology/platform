# session-solution-capture Specification

## ADDED Requirements

### Requirement: 会话菜单提炼入口

任一会话的菜单提供「存为我的方案」动作，打开提炼向导。

#### Scenario: 动作可达

- WHEN 登录用户在某会话打开会话菜单
- THEN 菜单含「存为我的方案」项（testid `session-save-solution`）
- WHEN 点击该动作
- THEN 提炼向导打开，名称预填会话标题、persona 与组合快照按会话启动 preset 预填

### Requirement: 示例提问勾选

向导从会话历史的用户消息中供勾选示例提问（默认前 3 条、至多 3 条），随预设保存。

#### Scenario: 默认勾选与改选

- WHEN 会话含 3 条以上用户消息
- THEN 向导默认勾选前 3 条，用户可取消或改选其他消息
- WHEN 用户消息不足 3 条
- THEN 默认全选现有消息，不虚构

#### Scenario: 限额拒收

- WHEN 勾选数超过 3 条或某条超 200 字
- THEN 保存被拒并指明原因，表单保持

### Requirement: 保存落为自定义预设

向导保存走既有自定义预设通道；成功后提供「去发布」引导（既有发布流）。

#### Scenario: 保存成功

- WHEN 用户确认保存
- THEN 预设经 POST /api/agent/presets 落账（含 examples），出现在预设列表
- AND 向导提示可发布（入口指向既有发布流）

#### Scenario: 向导取消不落账

- WHEN 用户取消向导
- THEN 无任何预设创建，会话与原预设不受影响
