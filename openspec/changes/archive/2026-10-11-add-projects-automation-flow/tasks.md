# Tasks: add-projects-automation-flow

## 1. 服务端：项目创建端点

- [x] 1.1 `server/routes/misc.js` 加 `POST /api/projects`：名称清洗（CJK/字母/数字/-/_、禁路径元字符、≤64）、`PROJECTS_ROOT`（默认 `<dataDir>/projects`）下 mkdir、已存在=附加、返回 `{path,name}`；错误 400 可读；curl 实测四例（正常/危险名/重名/超长）

## 2. 客户端：项目化新建

- [x] 2.1 `Sidebar` 弹层改名称优先（POST→set_workspace 全链），高级模式保留旧路径输入与校验；类型检查绿
- [x] 2.2 五语言 工作区→项目 文案 + 新建弹层新文案；`check:locales` 绿
- [x] 2.3 Composer workspace strip 文案核对（值改项目语境，行为不动）

## 3. 自动化：模板 + 自然语言排程

- [x] 3.1 `web/src/lib/scheduleParse.ts`：zh/en 模式表（每天/每周X/工作日/每N分钟/每小时/每月X日/en 兜底）→ `{cron,freq,time,weekdays,everyN,summary}|null`
- [x] 3.2 `TasksPage` 表单：NL 输入 + 防抖预览（cron+摘要）+ 应用填充 + 未匹配回退提示
- [x] 3.3 模板三枚 chips（简报/周报/巡检）预填 + 空态露出；五语言文案

## 4. 成果批量导出

- [x] 4.1 `jszip` 转直接依赖；ResourcesPage 文件条目 checkbox + 全选 + 「导出所选」→ 打包 `outputs-<date>.zip` 下载；未选时按钮隐藏；图表不参与
- [x] 4.2 导出文案五语言

## 5. e2e 与门禁

- [x] 5.1 新增/迁移用例：projects 端点（四例）、按名创建→切换链、模板预填、NL 解析应用与回退、批量导出含 zip 内容断言；既有 workspace 用例迁移；`check:locales`/lint/typecheck/build 绿
- [x] 5.2 受影响 spec 本地定向全绿；推 scs001 CI 全绿

## 6. 上线

- [x] 6.1 标准发布线出片→relay 实证→GitOps bump→ArgoCD 双滚→in-pod 实证（新端点 405→POST 冒烟 + bundle 标记）→公网冒烟
