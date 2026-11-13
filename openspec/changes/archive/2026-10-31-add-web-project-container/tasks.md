# Tasks: add-web-project-container

## 1. 存储与项目实体

- [x] 1.1 在 `db.js` 加启动迁移：`projects` 表（id/name/backing path 唯一索引/owner/created/updated）与 `chat_sessions`、document collections 两处可空 `project_id` 列；跑一次启动迁移验证旧库前向迁移且存量行零改写（注：cron jobs 在 jobs.json 文件存储，不在此 SQLite，其 project_id 走 2.2 棒记录字段）
- [x] 1.2 `server/routes/misc.js` 的 `POST /api/projects` 扩为"目录 + 项目行"一次成型、响应 `{ id, path, name }`；同 backing path 再建视为附着既有（命中既有行 id）；非法名 400 且不落行不建目录；新增 `GET /api/projects` 列表端点；单测覆盖三场景（新建/附着/拒绝）
- [x] 1.3 项目改名端点（只改 name 不动 path，无删除）；单测验证改名后 path 与既有会话归属不变

## 2. 归属落章（服务端单点）

- [x] 2.1 会话首镜像落章处（与 workspace 列同一落章点）按 backing path 回溯 `projects` 表写入 `project_id`（查不到保持 NULL）；不新增 enqueue 侧写手；单测：web 项目路径下新会话带章、桌面本地目录会话 NULL
- [x] 2.2 document collections 与 cron jobs 的创建路径带可空 `project_id`（从当前活动项目上下文解析；无上下文 = NULL 全局）；store 查询支持按 project 过滤、缺省"全部"；单测各覆盖"带章/无章/过滤/缺省全量"（cron jobs 走 jobs.json 记录字段，非 SQLite 列）

## 3. Web 表面

- [x] 3.1 `Sidebar.tsx` 分组键 fork：web = `project_id ?? 默认项目`（显示名、不显示绝对路径），桌面 = 现有路径分组与 Ungrouped 原样；默认项目组无改名/删除操作；现有单测在桌面键下全绿 + 新增 web 分组断言
- [x] 3.2 新建/切换项目流：`POST /api/projects` 返回的 id 记入前端活动项目上下文（沿用现成 `set_workspace` 切换链，不复制校验/确认/重启/广播）；真机或 e2e 验证"建名→切换→新会话落该组"
- [x] 3.3 `DocumentsPage.tsx` 与 `TasksPage.tsx` 项目过滤 UI（当前项目 / 全部 / 默认项目；默认视图 = 全部不过滤）；验证默认视图与改造前内容一致、切换过滤只影响展示

## 4. 回归与门

- [x] 4.1 i18n：新增文案键五语言齐（沿用 locale 门；「项目」「默认项目」用终词）；跑 locale 完整性门绿
- [x] 4.2 引擎契约不回归验证：workspace 切换链测试全绿（校验/确认/重启/广播行为不变），断言项目 API 任何调用不触发子进程重启
- [x] 4.3 双端 fork 串台防护：e2e 各一条分组断言（web 名分组 / 桌面路径分组），同一 payload 两态可见
- [x] 4.4 全量回归：`test:unit` + fleets/documents/cron 相关合同套绿；`openspec validate` 绿；台账登记（docs/registry-maintenance.md 相应节）
