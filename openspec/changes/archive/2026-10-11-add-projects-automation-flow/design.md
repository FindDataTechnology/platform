# Design: add-projects-automation-flow

## Context

R1 统一语言、R2 建立引导后，剩余的高频摩擦点集中在三条动线：新建工作区（绝对路径）、自动化（cron 控件 + 从零写提示词）、成果（逐个下载）。相关现状：`Sidebar.tsx` 新建弹层是绝对路径输入 + `set_workspace` WS 消息（服务端校验绝对/存在/可写，见 `workspace-selection` spec）；`TasksPage.tsx` 表单字段 mode/freq/time/weekdays/cronExpr/when/prompt/name/agent/tz，创建走既有 WS `cron_create`（REST `POST /api/cron` 同在）；成果文件字节经 `/api/files?root=resources&path=...` 服务，`jszip` 已在依赖树（传递），需转直接依赖。

## Goals / Non-Goals

**Goals:**

- 项目按名创建，绝对路径退居高级模式
- 自动化：模板一键填 + 一句话排程（纯客户端解析，离线可用）
- 成果文件多选打包下载
- 五语言 UI 壳照常；零 WS 契约变更

**Non-Goals:**

- 不改 set_workspace 校验/确认/重启链路与会话按路径戳分组的存储
- 不做 LLM 参与的排程解析（规则解析覆盖常用表述即可）
- 图表不参与批量导出（PNG 渲染导出留后续；文件字节导出已覆盖主要诉求）
- 不做项目删除/重命名（目录语义归文件管理器，本期只做"建+切"）

## Decisions

### D1 项目创建走 REST 增端点，不走 WS 新消息
`POST /api/projects {name}`：清洗（trim、内空白折叠为 `-`、保留 CJK/字母/数字/`-`/`_`、禁 `..` 与路径分隔符、≤64 字符，空结果 400）→ `mkdir -p <projectsRoot>/<slug>`（已存在同名字目录=附加语义直接返回）→ `{path, name}`。projectsRoot：`PROJECTS_ROOT` env 优先，默认 `<dataDir>/projects`（托管 cell 的数据目录可写且持久）。路由放 `server/routes/misc.js`（既有杂项配置面，同鉴权门）。**关键取舍**：不新增 WS 消息——WS 契约是绑定面，REST 增量端点是既定演进模式（trace/bots/resources 全是这么长出来的）；切换仍走 set_workspace，一行不改。

### D2 新建弹层：名称优先 + 高级折叠
`Sidebar` 弹层主输入=项目名（placeholder「比如：季度报告」），提交→POST→成功即 send `set_workspace`（沿用现有 pendingConfig/确认/重启处理）；失败（400/网络）显示错误不切换。次级「指定已有文件夹…」toggle 切换到旧路径输入（校验逻辑原样保留）。Composer 的 workspace strip 控件不动（它是"切换到已有"的入口）。命名文案 工作区→项目 仅改五语言值：`sidebar.workspaces`=项目、`sidebar.newWorkspace`=新建项目；`groupLabel` 已按路径 basename 显示，`/data/projects/季度报告` 天然显示「季度报告」。

### D3 排程解析：`scheduleParse.ts` 纯函数 + 优先级模式表
支持（zh 为主，en 常用兜底）：每天/每日 [早X点|下午X点半|X:MM]；每周[一..日]/周X [时间]；工作日 [时间]；每 N 分钟；每 N 小时；每小时 [第 M 分]；每月 X 日 [时间]；X 点半；en: every day / weekdays / every N minutes / at HH:MM。输出 `{cron, freq, time?, weekdays?, everyN?, summary}`，匹配不到返回 null。表单顶部单行输入 + 防抖实时预览（cron + 摘要），「应用」填充 freq/time/weekdays/cronExpr 字段；未匹配显示回退提示、零填充。时区沿用表单既有 tz。解析器带单测（vitest？仓库单测框架是什么——scripts 里 test:* 用 node:test 的有先例（app/），web 侧用 playwright 兜 e2e；解析器走 e2e 内的场景断言 + 纯函数直接被 e2e 引不方便——放 web/src 并在 e2e 里经 UI 断言即可）。

### D4 模板库：locale 驱动的三枚 chips
`tasks.templates.{briefing,weekly,inspection}`：名称+提示词+频次（每日 09:00 / 周五 17:00 / 每小时第 5 分）。渲染在表单上方与空态；点击=预填四件套（name/prompt/freq/time/weekdays），用户可改。空态文案顺带引一句「从模板开始」。

### D5 批量导出：jszip 客户端打包，文件类 only
`package.json` 增 `jszip` 直接依赖（树内已有，锁版本即可）。ResourcesPage：文件条目加 checkbox（图表条目无 checkbox）+「导出所选（N）」按钮（未选时隐藏）→ 逐个 fetch `/api/files?root=resources&path=<rel>`（既有存储字节链路，鉴权/Range 行为不变）→ JSZip 打包（文件名用显示名，冲突加序号）→ blob 下载 `outputs-YYYYMMDD.zip`。无新服务端路由。

## Risks / Trade-offs

- [projectsRoot 在托管 cell 是 /data/projects——重置数据目录会连项目一起没] 与会话/资料库同命运（同在数据目录），一致性可接受；env 可挪。
- [同名项目=静默附加旧目录] 对用户是"回到那个项目"的直觉语义；创建响应带 path，用户看到完整路径可辨。不做"已存在请改名"打断。
- [NL 解析覆盖不全造成"怎么不识别"] 回退提示明示可用手动控件；模式表随反馈增补，纯函数好加。
- [导出大文件占内存] JSZip 打包走 blob，资源库单文件本有 server 端上限（per-file ceiling），批量总量可控；v1 不做流式。
- [e2e 里创建项目会写文件系统] e2e 用临时 store 目录（per-spec DSH_HOME 已有机制），PROJECTS_ROOT 默认落在其中，无污染。

## Migration Plan

单镜像滚动（标准线）。`POST /api/projects` 是纯增量端点；前端弹层改动不影响既有 set_workspace 用户（高级模式保底）。回滚=revert 镜像 tag，无数据面风险。

## Open Questions

- 无——展示层细节（弹层视觉、chips 布局）实施期按视觉验收定。
