# mp-command-center Specification

## Purpose
小程序端的指挥台：`GET /api/mp/command-summary` 以单请求返回该实例的待答问询与定时任务状态快照（空态如实返回空集合），指挥台页三区呈现——待答问询可跳对应会话、任务异常可跳任务页、近期完成可查产物；任务页另提供「新建」入口，以预设档或自定义 cron 复用 `POST /api/cron` 创建定时任务。

## Requirements

### Requirement: 指挥台聚合端点

`GET /api/mp/command-summary` 以单请求返回该实例的指挥快照：待答问询与任务状态。

#### Scenario: 待答问询快照

- WHEN 存在会话的 agent 正在等待问询答复（pendingQuestionBySession 有条目）
- THEN 端点返回该会话的 askId、问题列表与会话标题

#### Scenario: 任务状态汇总

- WHEN 定时任务存在（任意状态）
- THEN 端点返回 active/paused/failed/interrupted 计数、failed 与 interrupted 的
  明细（含最近一次运行状态）、最近完成条目

#### Scenario: 空态诚实

- WHEN 无待答问询且无异常任务
- THEN 端点返回空集合（不报错、不虚构）

### Requirement: 指挥台页面

小程序提供指挥台页，三区呈现：待答问询（可跳转对应会话）、任务异常（可跳转任务页）、
近期完成（可查看产物）；各区空态如实显示。

#### Scenario: 三区渲染

- WHEN 用户打开指挥台且聚合端点返回非空数据
- THEN 三区按类渲染条目，点击问询条目进入对应 chat 会话

#### Scenario: 空态

- WHEN 聚合端点返回空集合
- THEN 各区显示「无待处理」提示，页面不报错

### Requirement: 移动端任务创建

任务页提供「新建」入口：填写提示词与计划（预设档或自定义 cron 表达式）创建定时
任务，复用既有 `POST /api/cron`。

#### Scenario: 创建成功

- WHEN 用户填写提示词与计划并提交
- THEN 任务经既有端点落账，列表刷新可见新任务

#### Scenario: 非法计划被拒

- WHEN 自定义 cron 表达式非法
- THEN 创建失败并显示服务端错误，表单内容保持
