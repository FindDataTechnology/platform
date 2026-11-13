## Purpose

从**消费方**视角规定词元能力快照（`GET /v1/ciyuan/capabilities`）的可依赖语义、禁止推断与降级义务。
生产者侧的响应形状与推导口径由 fork 仓 change `add-ciyuan-capability-endpoint` 定义，本文件只约束
「各产品线能据此推出什么、不能推出什么」——这是六条线共用一套推理规则的前提。

> 实现归属：sub2api fork 仓（`backend/internal/lanes/capabilities.go`）——本 spec 为跨仓行为契约，
> 审计时按文件间一致性核对：本文件与 fork 仓 `openspec/changes/add-ciyuan-capability-endpoint/specs/
> ciyuan-capability-endpoint/spec.md` 任一侧单独改动即视为漂移。

## ADDED Requirements

### Requirement: 消费方可依赖的字段与语义

消费方 SHALL 只依赖以下语义，且每条语义的用途 MUST 与其判据一致：

| 字段 | 消费方可以据此做的事 | 判据来源 |
|---|---|---|
| `models.serving[]` | 把它当作「此刻大概率能被路由到」的模型集合，用于默认模型选择与模型选择器排序 | 分组内可调度账号的模型映射并集（非实时探测） |
| `models.permitted_only[]` | 识别「看得见但大概调不通」的 id，用于告警或从候选里降权 | 可见集合 − `serving`；`basis` 说明它为何可见 |
| `models.permitted_only[].basis` | `allowlist` = 分组白名单放进来的孤儿；`platform_default` = 平台默认目录回落 | 分组白名单开关 |
| `lanes.<lane>.available` | 判断该车道此刻有没有候选上游账号 | 车道上游池候选数 > 0 |
| `media.*` | 判断该分组的图像/批量图像开关与已配置视频模型 | 认证分组快照 |
| `limits.*` | 只用于展示「配置限额」，MUST NOT 用于计算剩余可用量 | 认证快照的限额字段 |
| `generated_at` / `probed` / `basis` | 决定这份快照的时效与可信度；`probed=false` 时 MUST NOT 据此断言上游健康 | 生产者固定声明 |

#### Scenario: 用 serving 选默认模型

- **WHEN** 消费方需要为一个未显式指定模型的调用挑默认模型
- **THEN** 它 SHALL 优先从 `models.serving[]` 中挑，且 MAY 按自身偏好排序
- **THEN** 它 MUST NOT 因 `serving` 为空而断定「该 key 无模型可用」——白名单关闭时 `permitted_only`
  里的 `platform_default` 项仍可能可调，最终判定仍以真实请求为准

#### Scenario: 识别孤儿白名单

- **WHEN** 某 id 出现在 `permitted_only` 且 `basis == "allowlist"`
- **THEN** 消费方 MAY 把它标为「配置与账号不一致」并告警
- **THEN** 它 MUST NOT 自动删除该 id 或改写分组白名单（写操作归管理端）

### Requirement: 快照只承诺模型层面的权益，不承诺「能成功」

能力快照的 `serving` 只表示「该 key 在模型层面有权且当前有可调度账号」，**不代表调用一定成功**。
订阅/分组状态、余额耗尽、IP 白名单等其它门在快照之外，命中时仍会被拒。消费方 SHALL 据此把
快照当作**选型建议**，MUST NOT 当作成功率保证或前置健康检查的唯一依据。

#### Scenario: 模型有权但订阅失效

- **WHEN** 某 key 的 `serving` 非空（模型层面有权），但其所属分组没有有效订阅
- **THEN** 真实请求仍会被拒（实测形态：HTTP 403，`No active subscription found for this group`）
- **AND** 消费方 MUST NOT 因「快照显示可服务」而跳过自身的错误处理与降级

### Requirement: 明令禁止的推断

消费方 MUST NOT 做以下推断，任何一条被违反即视为契约违约：

1. 把 `probed=false` 的 `serving` 当作**实时可用性**——它是账号配置口径，账号可能在下一毫秒冷却。
2. 把 `null` 当作 `false` / `0` / 空集：`lanes.*.available == null` 表示「不知道」（池未装配或取数失败），
   `media.video.models == null` 表示「未配置」，均 MUST NOT 被渲染成「不支持」。
3. 把 `limits` 段的任何字段当**剩余可用量**：它们是限额配置值；`window_usage` 恒为 `null`。
4. 把 `key_quota_usd == 0` 当作零额度——必须读 `quota_unlimited`。
5. 在 `kind == "unknown"` 上按 chat / image / video 分类分发请求——生产者刻意不猜，
   消费方若要分类 MUST 用自己的族表（如 `dsh-profile.js` 的模型元数据），并自担口径。

#### Scenario: null 被渲染成不支持

- **WHEN** 某车道 `available` 为 `null`（池未装配或取数失败）
- **THEN** 消费方界面 MUST 显示「暂不可知」而非「不可用」，且 MUST NOT 据此摘除该车道入口

#### Scenario: 额度为零被读成用尽

- **WHEN** 消费方看到 `key_quota_usd == 0`
- **THEN** 它 MUST 先读 `quota_unlimited`；为 `true` 时 MUST 显示为「不限」

### Requirement: 不可达时的降级义务

消费方接入能力快照后 MUST 保留既有路径作为降级，且降级 MUST NOT 比现状更差：

- 端点返回 404 / 501（旧版词元未部署该能力）→ 消费方 MUST 退回接入前的既有行为（如壹座的探测式 sync）。
- 端点返回 503（网关服务未装配）→ 同上，MUST NOT 把失败当空能力。
- 端点超时或网络错误 → 同上，且 MUST 有上界（不得让一次能力查询拖死请求路径）。

消费方 MUST NOT 因为「快照可用」而删除既有探测/硬编码路径——探测保留为**校验**：两者结论分歧时
产生可观测的告警，而不是静默采纳任一方。

#### Scenario: 旧版词元没有该端点

- **WHEN** 消费方请求 `/v1/ciyuan/capabilities` 得到 404
- **THEN** 它 MUST 退回接入前的行为，且 MUST NOT 报错给终端用户

#### Scenario: 快照与探测结论分歧

- **WHEN** 快照称某 id `serving` 但探测判定 `unauthorized`（或反之）
- **THEN** 消费方 MUST 记录一条可观测告警（含两侧判据与 `generated_at`），
  MUST NOT 静默以任一方覆盖另一方

### Requirement: 契约的双仓一致性

本契约与 fork 仓同名 spec MUST 保持语义一致。任一侧新增/修改字段语义时，另一侧 MUST 同批修订；
审计 SHALL 以「两文件对同一字段的表述是否可同时为真」为判据。

#### Scenario: 只改了一侧

- **WHEN** fork 仓新增字段或改变某字段语义，而本文件未同步
- **THEN** 审计 MUST 判定为漂移，且该改动 MUST NOT 被视为已交付给消费方
