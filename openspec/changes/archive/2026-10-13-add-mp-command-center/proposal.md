# add-mp-command-center

## Why

壹座 roadmap Y3 第一片（`docs/yizuo-platform-roadmap.md`，2026-10-13 定案）：移动端职责
=远程指挥+简单对话。MP 小程序是分发在产的一端，其指挥要素已散落在各页（问询卡可提交
答案、cron 页有状态机+rerun+产出查看），但**没有指挥台**——用户打开小程序第一屏是聊天页，
看不到「有什么在等我处理」：哪个会话的 agent 正在等我问询答复、哪个定时任务失败了、
昨晚的任务产出了什么。远程指挥的第一步是**一眼看清局面**，第二步才是行动。

通知触达（微信订阅消息直达）依赖模板申请（用户行动项），挂为 Y3 第二片——本片完全
自主，不依赖任何微信资质。

## What Changes

- **服务端聚合端点** `GET /api/mp/command-summary`（server/routes/mp.js）：
  - `pendingQuestions`: `ctx.pendingQuestionBySession` 运行时快照（内存态语义正确——
    turn 活着才有意义，重启后空态诚实），join 会话标题（chat-history 元数据）
  - `jobs`: cron.listJobs() 汇总——active/paused/failed/interrupted 计数 + failed/
    interrupted 明细（id/name/lastRun 状态）+ 最近完成 N 条
  - store-local 原则（M4④ 同款）：单实例内聚合，不跨域
- **MP 指挥台页** `pages/command/index`：三区——待答问询（点进对应 chat 会话）、
  任务异常（failed/interrupted 列表→cron 页）、近期完成（→产物查看）；空态各区诚实
  显示「无待处理」
- **入口**：chat 页导航与 HistoryDrawer 增加「指挥台」入口（沿用现有页面跳转模式，
  PageHeader 标题+返回）
- **cron 创建表单**（MP cron 页「新建」）：prompt+计划（预设档：每天 HH:mm / 每周几
  HH:mm / 自定义 cron 表达式）——`POST /api/cron` 既有端点复用，preset 取当前用户
  选中角色（服务端 currentPreset 兜底已备）
- i18n：MP 双语（zh-CN/en）词条；测试：聚合端点单测（stub ctx/cron）+ 页面冒烟

## Capabilities

### New Capabilities

- `mp-command-center`: 小程序指挥台——待答问询/任务异常/近期完成三区聚合面+
  移动端定时任务创建。

### Modified Capabilities

（无——cron REST/问询 WS 通道均既有，本片纯消费+聚合）

## Impact

- **新增**：`server/routes/mp.js` 增 command-summary 端点、`miniapp/src/pages/command/`、
  cron 页创建表单组件、双语词条、单测
- **复用**：`ctx.pendingQuestionBySession`（add-user-questions 内存态）、`cron.listJobs()`
  （状态机既有）、`POST /api/cron`、chat-history 会话元数据、QuestionCard/cron 页跳转
- **不触碰**：web 端、问询应答 WS 协议、cron 引擎本身
