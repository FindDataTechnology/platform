# Proposal: add-projects-automation-flow

## Why

R1/R2 解决了"看得懂、有人教"，R3 处理最后一批劝退点：新建工作区要求输入**绝对路径**（非技术用户的第一拦路虎）、自动化任务要懂 cron/频次控件（且从零想提示词）、成果逐个下载。这三处都发生在用户最高频的动线上，改完壹座的日常流才算真正顺手。

## What Changes

- **工作区 → 项目（按名创建）**：新增 `POST /api/projects {name}`——服务端在项目根（`PROJECTS_ROOT` env，默认 `<数据目录>/projects`）下清洗名称建目录，返回绝对路径；客户端新建弹层改为**项目名优先**（起个名就建），旧的"指定已有文件夹"保留为高级模式（绝对路径校验原样）。切换链路复用既有 set_workspace 契约（校验/确认/重启/广播零变更）。UI 文案 工作区→项目（i18n 值，键与存储不变——会话仍然按路径戳分组）。
- **自动化模板库**：任务表单加模板 chips（每日数据简报 / 每周周报 / 每小时巡检），点击预填名称+提示词+频次；空态同样露出模板。
- **自然语言建任务**：表单顶部加一句式输入（"每周一早上 8 点…"），`scheduleParse.ts` 客户端解析 zh/en 常见表述 → 预览生成的 cron 与人类可读摘要 → 应用即填充表单字段；解析失败提示改用下方手动控件。不做 LLM 调用（纯客户端规则解析，离线可用）。
- **成果批量导出**：成果页多选（文件类）→ 客户端 JSZip 打包下载 `outputs-<date>.zip`；图表类资源 v1 不参与导出（选择器跳过并注明数量）。新增直接依赖 `jszip`。

## Capabilities

### New Capabilities

- `project-workspace`: 按名创建项目——服务端清洗名称、在项目根下建目录、返回绝对路径；名称清洗规则（CJK/字母/数字/连字符/下划线，禁路径元字符）、已存在目录的附加语义、鉴权与错误面。

### Modified Capabilities

- `sidebar-workspaces`: 新建动作改为项目名优先的输入（仍复用 set_workspace 全链契约：校验、中途确认、重启、广播）；绝对路径输入保留为高级模式，其校验行为不变。
- `scheduled-tasks-ui`: 任务创建表单新增模板 chips（预填）与自然语言排程输入（解析预览、应用填充、失败回退手动控件）；既有表单字段与创建行为不变。
- `resource-library-ui`: 成果页新增文件类资源的多选与批量导出（客户端打包 zip 下载）；图表类不参与且不阻断；既有单资源操作不变。

## Impact

- `server/routes/misc.js` 或新 `server/routes/projects.js` — `POST /api/projects`（清洗/建目录/返回路径；`PROJECTS_ROOT` env）
- `web/src/components/Sidebar.tsx` — 新建弹层项目名优先 + 高级模式
- `web/src/pages/TasksPage.tsx` — 模板 chips + NL 排程输入
- `web/src/lib/scheduleParse.ts`（新）— zh/en 排程表述解析
- `web/src/pages/ResourcesPage.tsx` — 多选 + 批量导出（jszip）
- `package.json` — 直接依赖 `jszip`
- `web/src/locales/*/common.json` — 工作区→项目文案、模板/NL/导出文案（五语言）
- e2e — projects 路由用例、模板/NL 用例、导出用例；既有 workspace 用例迁移
- 零 WS 契约变更；set_workspace 校验/确认/重启链路原样
