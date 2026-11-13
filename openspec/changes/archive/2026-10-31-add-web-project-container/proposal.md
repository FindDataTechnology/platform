# Proposal: add-web-project-container

## Why

Web 端现在的顶层容器是"目录"（workspace 路径字符串）：`POST /api/projects` 已经能按名字物化一个目录（add-projects-automation-flow），但目录名不是身份——会话按路径字符串分组、知识库 collection 与定时任务完全无归属。线上用户没有文件系统，`/…/projects/季度报告` 这类路径对他们近乎噪音；而后续的知识库 agents（检索边界）与永忆深通（记忆 scope 键）都必须挂在"有身份的容器"上。本 change 把 Project 从目录名升格为实体，作为 web 端顶层容器；桌面端维持目录心智，零行为变化。

## What Changes

- 新增 `projects` 持久实体：服务端项目表（id、name、目录 path、created/updated、owner），`POST /api/projects` 从"只造目录"改为"造目录 + 落项目行"并返回 `{ id, name, path }`（响应新增 `id` 为向后兼容扩展）。
- 会话归属：`chat_sessions` 加可空列 `project_id`；web 端首帧/新建项目时以 id 落章，存量行与桌面端行保持 NULL。
- 知识库归属：document collections 加可空 `project_id`；collection 列表页与检索边界按项目过滤（NULL = 全局/默认）。
- 定时任务归属：cron job 加可空 `project_id`；任务页默认展示当前项目 + 无主任务。
- 侧栏分组：web 端会话区改按 Project（显示名）分组，路径降为项目属性（悬停/详情可见）；桌面端（`IS_DESKTOP` 分叉）维持现有按路径分组不动。
- 默认项目：未归属会话/collection/job 落"默认项目"虚拟分组，不迁移历史数据、不改写既有 workspace 章。
- 引擎契约不变：`set_workspace` 仍收路径、dsh 子进程 cwd 机制不动、路径可写硬要求不动；Project 是路径之上的容器，不是路径的替代。

**非目标（明确排除）**：团队（fleet）、智语房间、产出（resources）的 Project 归属（留待后续把容器扩到大范围时再议）；桌面端 Project 视图切换（独立小件）；知识库 agents 的调用面与展示面（姊妹 change `add-knowledge-memory-surface`，依赖本 change）。

## Capabilities

### New Capabilities

- `project-container`: Project 实体的生命周期与归属契约——服务端项目表与创建/改名/列举、`project_id` 可空归属列（会话/collection/任务）、默认项目回落、"web 走项目、桌面走路径"的表面分叉不变式、引擎 cwd 契约不受影响的边界条款。

### Modified Capabilities

- `project-workspace`: 按名创建目录的要求扩展为"目录 + 项目行"一次成型，响应携带项目 id；创建仍不得触碰运行中 dsh 的既有约束保留。
- `sidebar-workspaces`: 分组键从"路径字符串"改为双轨——web 按 Project 名分组（未归组落默认项目），桌面按原路径分组；组名不再直接展示绝对路径。

## Impact

- 存储：`db.js` 迁移加 `projects` 表与三张表的 `project_id` 可空列（存量零改写）。
- 服务端：`server/routes/misc.js` 的 `/api/projects` 扩返回体；documents/cron 的 store 读写带项目过滤；会话铸造链（`upsertSession`）带上 project 章。
- Web：`Sidebar.tsx`（分组逻辑 + IS_DESKTOP 分叉）、`DocumentsPage.tsx`、`TasksPage.tsx`（项目上下文与过滤）。
- 不动：dsh 引擎桥（`server/agent-session.js` 的 workspace/cwd 链）、桌面端任何现有交互、永忆存储层（scope 对齐在姊妹 change 处理）。
- 词汇：web 端用户可见文案用「项目」；代码键与 API 字段沿用 `project`，不翻既有键。
