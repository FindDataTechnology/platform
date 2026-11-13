# fix-fleet-turn-attribution Proposal

## Why

fd-wire 普查（178 回合）中 27 次 `timeout` **全部**卡在 600–616 秒预算上限，回合记录只有 `turn timed out` 五个字——没有最后调用的工具、没有步数、没有卡住点；运维无法区分「模型慢」「工具挂死」「prompt 让模型做了不该做的事」，同类问题在别的舰队会反复出现。同时 16 次 `model_upstream` 集中落在 30 分钟窗口内，**无熔断、无降级**：上游 5xx 期间每轮照常撞墙放大失败计数，`fallbackModel` 字段存在但运行期从不生效。

另一个约束决定设计形状：**模型车道即将不再共享**——不同 agent 将配置各自的 LLM key 与 baseURL（多 provider 在 profile 层已落地：`buildUserProviderEntries` 每条自带 baseURL 与独立 `apiKeyEnv`），只是回合层从未感知车道身份。任何熔断/归因机制若把「cell 共享单车道」焊死在代码里，将在多车道落地日整体作废。

## What Changes

- **timeout 归因（摘要列）**：`collectTurn` 的工具调用块补时间戳；超时 reject 时从闭包状态构建摘要（`kind: stalled|budget_exceeded`、步数、最后工具名与已等待时长）随错误透传，落进回合事件新 `detail` JSON 列。**不做读时 trace join 做主机制**——两表保留期独立，join 会静默 NULL；trace 照旧供深挖。
- **车道身份一等化**：`laneKeyFor(provider) = sha256(providerId|baseURL|apiKey)` 前 16 位（不含明文密钥）；启动时按 profile 的 providers 构建模型→车道映射；回合事件 detail 记 `laneId`。未来 per-agent 车道只改解析来源，不改本机制。
- **车道键控熔断**：`server/llm-lane.js`——按 laneId 的滑动窗熔断注册表（10 分钟内 ≥5 次 model_upstream → 开窗 10 分钟，env 可调 + 关闸）；开窗期回合记 **`skipped`**（新状态：不计连败、不判 failing、presence 照常推进——「没跑 ≠ 失败 ≠ 正常」三分口径与停机补跑、failing 档同构）。cell 共享单车道时自然退化为 cell 级。
- **上游失败降级重试一次**：`model_upstream` 失败（且回合启动 <60s、解析链还有未试候选）→ 换下一档模型重试一次，detail 记 `degradedTo`；超时/工具类失败不重试。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `agent-fleet-core`：「成员回合产出回合结果事件」——status 枚举增 `skipped`（平台主动跳过：车道熔断开窗），事件增 `detail` 摘要列（timeout 归因 / degradedTo / laneId）；连续失败聚合语义不变（skipped 非失败）。
- `cron-module`：新增「模型车道熔断」需求——按车道键控的滑动窗熔断、开窗期回合 skipped、降级重试一次。

## Impact

- 代码：`server/cron-runner.js`（collectTurn 时间戳+摘要、breaker 检查、降级重试）、`server/fleet-events.js`（detail/skipped 映射）、`server/routes/fleets-db.js`（detail 列 + 反序列化）、`server/llm-lane.js`（新）、`server.js`（车道映射构建）、`task-engine.js`（skipped 分支）、web 三件 + 五语言。
- 数据：`member_turn_events` 加一列 `detail TEXT`（fleets-db 的幂等 ALTER 机制，无版本链迁移）；旧行 detail 为空诚实缺省。
- 不涉及：worker 槽位（独立 bridge，车道语义后续跟进）、a2a/tool 岗位（不走模型车道）、停机补跑与 failing 档（已上产的两套口径只被复用不被改动）。
