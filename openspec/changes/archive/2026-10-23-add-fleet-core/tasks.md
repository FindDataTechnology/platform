# Tasks: add-fleet-core

## 1. 存储与引擎透传

- [x] 1.1 建 fleets-db 模块（fleets.db：fleets/members 两表，模式抄 clusters-db.js）并验证建库/迁移/CRUD 冒烟测试通过（node --test）
- [x] 1.2 task-engine 加可选 sourceTag 透传字段（insert/load/save/serialize/broadcast 四处原样携带），验证：带标签任务持久化往返一致 + 既有无标签任务零扰动回归绿
- [x] 1.3 reconcile 模块：成员期望集 vs sourceTag 任务集的 diff 增/改/停（无节奏被动岗期望集为空），验证幂等（连续两次对账零变更）、改节奏不产孤儿任务、撤节奏转被动岗的单测

## 2. API 面

- [x] 2.1 server/routes/fleets.js：舰队 CRUD + 状态转移（pause/resume/archive），鉴权与 ownerEmail 归属校验抄 clusters.js，验证越权 403 与非法输入 400 不落库的单测
- [x] 2.2 成员路由：建岗（targetRef 三类校验+唯一岗校验：persona/cluster 已在岗拒绝带现有岗位名）/改岗（成环拒绝）/删岗/换防 swap（唯一岗拒绝+freshSession 清史选项，报数史不动）/成员级暂停恢复，每条写路径后同步对账，验证 swap 后物化任务 preset 已更新且任务 id/会话在未清史时不变、清史时会话重开
- [x] 2.3 在岗派生读面：GET 详情携带 on_duty|paused|missing|vacant|passive 派生态与判定依据（lastRunAt/staleWindowMs/nextRunAt），验证删 persona 后 vacant、超窗后 missing、无节奏岗 passive 的单测
- [x] 2.4 server.js 挂路由 + e2e 可达性：auth-on/auth-off 两模式下 /api/fleets 读写各一条真请求绿

## 3. 前端管理面

- [x] 3.1 FleetsPage（/fleets 路由）：舰队列表 + 成员树 + 岗位卡（在岗者/节奏人读/派生态徽章/判定依据 tooltip），stub API 断言树形成渲染与 vacant/missing 徽章呈现
- [x] 3.2 编队器对话框：目标选择（persona/cluster/a2a 三类，复用目录读取）、岗位命名、节奏设置（<10 分钟需确认）、组织关系设定，e2e 建一只三岗位舰队走查绿
- [x] 3.3 换防/暂停/恢复/归档操作与确认态 + i18n 双语 + 主侧栏「舰队」导航（sections/surveys/resolvedLayout 三处同源同步），角色布局白名单回归绿

## 4. 活体验收

- [x] 4.1 生产走查（aloadtree 口径，2026-10-23 全链闭环含删 persona→vacant（reason=target object no longer exists）→swap 补岗恢复）：建队 → 物化任务在 /tasks 可见且带舰队标 → 换防历史连续 → 删 persona 得待补岗 → 补岗恢复；全队暂停即刹车、恢复后成员级暂停仍保持
- [x] 4.2 既有任务零扰动回归（全量单测零扰动 1875/1875 + 生产滚后既有 cron 面正常；逐条比对快照以单测 load→schedule 钉住代偿）cron/集群既有任务在 load 后 schedule 行为不变（模块测试 + 一次真滚动后 /tasks 列表比对）

