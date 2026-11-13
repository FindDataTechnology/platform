# permission-mode-selection 三处校正（N-5）

## Why

审计 N-5 的原始判断（「spec 落后于危险命令确认对话流」）**是错的**：确认流本身
完全实现且与 spec 对得上（`ControlStrip.tsx:264-294,421-427,774-777`、
`e2e/composer-controls.spec.js:92-130`、五语文案齐）。逐条核完，真正的失真有
三处，其中一处是把**已不存在的语义**当成契约：

1. **R4 整条过期。** spec 写「重启（model、workspace 或 preset 切换）会把权限重置回
   部署默认」。但 `add-wire-dsh-live-runtime-control` 之后 `model/set` 是活方法：
   切模型不再重启子进程，会话与它持久的权限事件一起延续，**选的模式跨模型切换保留**
   （`e2e/agent-permission.spec.js:65-90` 就是这条断言）。照 spec 写测试会写出一条
   必红的用例，而且会把「切模型就静默撤销用户明确选的权限」当成正确行为——那正是
   这条 spec 现在在背书的事。
2. **R5 表格一行错。** 表里说 `permissions` 在「connect 和每次切换后」下发；实际切换后
   只推 `current_permission`（`server/agent-session.js:1016`），名册只在 connect
   （`server/ws.js:415`）或显式 `list_permissions` 时发。客户端若照 spec 等切换后的
   名册，就等不到。
3. **R1 措辞错。** spec 说控制条显示「effective preset name」；实际渲染的是**本地化
   label**（`ControlStrip.tsx:412-417,502`，英文是 "Chat only" 一类），名册外条目才回落
   到服务端原串。

R2/R3 逐条核过成立，不动。

## What Changes

- `permission-mode-selection` R1：改成「effective preset 的本地化 label」，并补一条
  「custom 只显示、不出现在菜单里」的场景（名册只收 `service.names`）。
- R4：改写为「子进程真正重启（workspace/preset 切换、崩溃重拉）才回到部署默认」，
  并新增「模型切换保留当前模式」的场景；旧场景改成用 workspace/preset 切换触发。
- R5：表格那行改成「connect 与 `list_permissions` 应答时下发；切换后只推
  `current_permission`」。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `permission-mode-selection`：三条 Requirement 按代码与既有 e2e 实况回写。

## Impact

- 纯 spec 文本；零代码改动。
- 遗留（不在本单）：权限切换目前**没有授权检查**——任何已连接客户端都能切换共享实时
  会话的模式（`server/ws.js:876-886`），且 `danger-full-access` 的确认只在客户端做。
  属产品决定（单用户 cell 下可接受，多客户端共享部署下需拍板），另单处理。
