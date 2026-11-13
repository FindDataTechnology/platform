# Design: add-web-project-container

## Context

见 proposal.md - Why。作为设计输入的现状约束（均已代码核实）：

- 会话行已有 `workspace` TEXT 列（`db.js:212`），首镜像章固定、不随切换改写（spec: sidebar-workspaces）。
- `POST /api/projects` 只物化目录（`server/routes/misc.js:822`），无 id、无记录行。
- dsh 引擎契约 = cwd 路径：可写硬要求、切换重启子进程、`workspace_changed` 广播（`server/agent-session.js`）。此链本 change 全程不碰。
- 同一 SPA 双端分叉已有机制：`IS_DESKTOP` + `predicates.desktopOnly`（`packages/core/src/lib/surfaces.ts`）。
- 永忆 v2 scope 已是"一根多 project"形状（`u/<user>/p/<proj>`），但那是存储层分区，与本容器 project 尚未打通——打通属姊妹 change。

## Goals / Non-Goals

**Goals**：Project 成为 web 端有身份的容器；三类内容（会话/collection/定时任务）可空归属；桌面与引擎链零行为变化；存量零迁移。

**Non-Goals（设计层面额外划界）**：不做项目成员/共享（归属仍按账号 owner 单租户）；不做项目配额；不在本 change 引入"项目详情"独立页面（分组 + 过滤即可，页面化随知识记忆面）；不碰永忆 scope 键映射。

## Decisions

**D1 · 新表 `projects`，而非把路径字符串升格。**
备选是"以 workspace 路径为 project 身份"（零新表）。否决：路径改名即断链、无法携带显示名与创建时间、桌面任意目录会污染项目名册。新表 + 可空 `project_id` 列是叠加；`path` 作为表的属性保留，与既有行按"路径回溯"对账（见 project-workspace delta 的 reconcile 场景）。

**D2 · 归属靠"活动项目上下文"落章，不靠前端每条消息带 id。**
客户端切到某项目（经现成 `set_workspace` 链）后，服务端把"当前活动 path→project id"解析记在会话首镜像处（按路径回溯查表，查不到 = NULL）。备选是 WS 消息显式带 `projectId`。否决：显式带 id 让 enqueue 侧多一个写手——注入缝唯一化的既有教训（横切关注点写 enqueue 侧，路径增长必漏）；按路径回溯在落章点单点完成，桌面来的本地目录天然查不到 → NULL，桌面零改动自证。

**D3 · 侧栏分组 fork 用读时派生，不加渲染开关。**
web 分组键 = `project_id ?? 默认项目`；桌面分组键 = `workspace`。同一 `groups` useMemo 里按 `IS_DESKTOP` 选键。备选=桌面也显示项目视图——留作后续独立小件（用户已拍），本刀不动桌面分组语义。

**D4 · 默认项目是读时虚拟组，不建行。**
建行会让存量归属变成可删实体（删了"默认项目"= 孤儿化全部遗留内容）。虚拟组在 UI 上不出现改名/删除操作即可。

**D5 · 改名只改显示名，目录恒不动。**
目录移动会破坏 cwd 语义与历史路径对账。name 与 path 解耦后，path 成为纯实现细节，符合"容器有身份"的目标。

## Risks / Trade-offs

- [路径回溯对账的歧义：同一 path 两行项目记录（删除重建同名目录）] → 表上 backing path 唯一索引，reconcile 按 path 命中单行；删项目仅删行不删目录，目录复用视为"附着既有"（project-workspace 既有场景已覆盖）。
- [collection/job 加列后既有全局视图行为变化引起回归] → 列可空、过滤缺省"全部"，默认视图不过滤；项目过滤是增益 UI。
- [首镜像落章时机依赖会话铸造链] → 与既有 workspace 列同一落章点加一行解析，不新增时机。
- [双端 fork 若判定源不可靠会串台] → 复用 IS_DESKTOP 单一判定（与 nav 谓词同源），e2e 各测一条分组断言。

## Migration Plan

1. 建表加列（全部可空/新增，SQLite 在线迁移，存量行零改写）。
2. 服务端 `/api/projects` 扩返回 `id` 并写行；旧客户端忽略 `id` 不受影响。
3. web 侧栏/collection/job 读路径带项目过滤（默认全部）。
4. 回滚 = 逆序：前端回退 → 读路径回退 → API 回退（多出的 `id` 字段与列留存无害）。

## Open Questions

- 项目删除/归档的用户语义（删行留目录？还是连目录标记清理？）——不影响本刀归属链，随大范围容器扩时再定；本刀不做删除 UI，API 先不提供 delete。
