# ciyuan-media-lane Specification

## Purpose

词元网关上的图像与视频生成车道：以 OpenAI 兼容形状对外暴露同步/异步图像、批量图像与视频生成/编辑/扩展端点，复用既有 key 鉴权、模型白名单与计量账本，并对异步任务提供状态与内容取回。实现归属：sub2api fork 仓（`backend/internal/server/routes/gateway.go`），本 spec 为跨仓行为契约。

## ADDED Requirements

### Requirement: Media endpoints are exposed on the existing gateway
词元 SHALL 在既有 `/v1` 网关下暴露以下端点族，全部复用 chat/embeddings 入口的鉴权链与 body 限额：同步图像 `POST /images/generations`、`/images/edits`；异步图像 `POST /images/generations/async`、`/images/edits/async` 与 `GET /images/tasks/:task_id`；批量图像 `POST/GET /images/batches*`；视频 `POST /videos`（OpenAI 兼容别名）、`/videos/generations`、`/videos/edits`、`/videos/extensions` 及对应的 `GET /videos/:request_id[/content]` 状态/内容取回。OpenAI 兼容客户端 SHALL 能通过 `/videos` 创建任务，而 Grok 媒体转发器内部使用 `/videos/generations` 规范路由。

#### Scenario: SDK creates a video through the compatible alias
- **WHEN** 客户端以有效词元 key 调用 `POST /v1/videos`
- **THEN** 请求 SHALL 由视频生成处理器承接，并返回与 `/videos/generations` 同形状的任务标识
- **AND** 该笔请求 SHALL 受同一 key 的身份与模型白名单约束

#### Scenario: video status and content are retrievable
- **WHEN** 客户端以创建时返回的 `request_id` 调用 `GET /v1/videos/:request_id` 与 `/content`
- **THEN** 分别 SHALL 返回任务状态与生成内容，且 SHALL NOT 要求第二套凭据

### Requirement: Media requests pass the shared key identity and model allowlist
图像/视频请求 SHALL 与 chat 入口共用同一 API key 鉴权、分组模型白名单与余额硬顶；白名单不覆盖的模型 SHALL 在触达上游前拒绝。异步提交 SHALL 继承同样的准入判定，且管理台可对该类提交做启停（admin toggle）而不影响其它车道。

#### Scenario: disallowed model never reaches upstream
- **WHEN** 请求体携带不在分组白名单内的模型名
- **THEN** 网关 SHALL 拒绝该请求
- **AND** 上游供应商 SHALL NOT 被触达

#### Scenario: admin toggle disables async submission
- **WHEN** 管理台关闭异步图像提交
- **THEN** `POST /images/generations/async` SHALL 拒绝新任务
- **AND** 已存在任务的状态查询 SHALL 仍可用

### Requirement: Async and batch jobs have an inspectable lifecycle
异步图像任务 SHALL 返回可查询的 `task_id`，`GET /images/tasks/:task_id` SHALL 返回其状态与结果引用；批量图像 SHALL 支持列举、单项内容取回、下载、取消与记录/产物删除。视频任务 SHALL 以 `request_id` 提供状态与内容取回。任务未完成时 SHALL 返回进行中状态而非伪造产物。

#### Scenario: task is polled before completion
- **WHEN** 客户端在异步图像任务未完成时查询 `/images/tasks/:task_id`
- **THEN** 响应 SHALL 表明任务仍在进行
- **AND** SHALL NOT 返回「已完成」的假产物

#### Scenario: batch is cancelled and cleaned
- **WHEN** 操作员取消一个批量任务并删除其记录与产物
- **THEN** 后续列举/取回 SHALL NOT 再返回该批次

### Requirement: Media usage rides the shared metering ledger
图像/视频生成 SHALL 按既有车道价目与用量记录口径计费（同 key、同余额、同用量行），SHALL NOT 引入第二套计量或凭据体系。异步/批量的用量 SHALL 归属提交任务的 key，取回内容 SHALL NOT 重复计费。

#### Scenario: async submit records usage once
- **WHEN** 一个异步图像任务提交并最终完成
- **THEN** 用量 SHALL 记在提交 key 的账上一笔
- **AND** 后续 `GET /images/tasks/:task_id` 内容取回 SHALL NOT 新增用量

### Requirement: Upstream and policy failures are surfaced, not fabricated
上游超时/拒绝、并发限流、安全审核拦截与配额耗尽 SHALL 以结构化错误返回，错误形状 SHALL 与网关既有车道一致；SHALL NOT 以空白或占位产物冒充成功。上游故障 SHALL 触发既有账号故障转移语义。

#### Scenario: blocked prompt is refused with a structured error
- **WHEN** 安全审核拦截一个异步图像提交
- **THEN** 网关 SHALL 返回结构化错误
- **AND** SHALL NOT 创建任务或写入用量

#### Scenario: image concurrency limit rejects cleanly
- **WHEN** 图像并发达到配置上限
- **THEN** 新请求 SHALL 被拒绝并带明确的限流错误
- **AND** 已受理请求 SHALL 不受影响
