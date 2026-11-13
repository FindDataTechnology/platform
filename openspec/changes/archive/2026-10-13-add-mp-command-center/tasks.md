# Tasks — add-mp-command-center（Y3 第一片：MP 指挥台）

## 1. 服务端聚合端点

- [x] 1.1 `GET /api/mp/command-summary`（routes/mp.js）：pendingQuestions 快照
      （askId/sessionId/questions + 会话标题 join）+ jobs 汇总（计数 + failed/
      interrupted 明细 + 最近完成）；MP 鉴权语义与既有 mp 路由一致
- [x] 1.2 单测（scripts/test-mp-command-summary.mjs）：stub ctx/cron——pending 快照
      形状、空态、状态机计数、failed 明细

## 2. MP 指挥台页

- [x] 2.1 `pages/command/index`：三区（待答问询→chat 定位 / 任务异常→cron 页 /
      近期完成→产物），双语，空态诚实；PageHeader 家法
- [x] 2.2 入口接线：chat 导航/HistoryDrawer 加「指挥台」；app.config.ts 注册页面
- [x] 2.3 （核实改判：cron 页新建表单**已既有**——周期/单次×每天/每周/自定义 cron+preset 选择+时区+创建确认 harden，走 WS cron_add；本片 proposal 误判为缺口，无需新做）

## 3. 测试与上线

- [x] 3.1 typecheck+build:weapp+biome 绿；生产端点 401 门实证（路由在+鉴权生效）；页面眼见留用户（微信开发者工具/体验版，下个提审窗随版本）
- [x] 3.2 出片 sha-f1da0ed（快照+恢复 image.yml 配方）→ GitOps e8eb371 双清单滚 → in-pod 探针 401 门实证
- [x] 3.3 归档 + roadmap Y3 第一片标注；微信提审随下个版本窗
