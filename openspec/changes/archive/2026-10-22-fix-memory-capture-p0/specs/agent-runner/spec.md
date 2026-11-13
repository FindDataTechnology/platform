## MODIFIED Requirements

### Requirement: 部署 agent 的工作记忆经平台缝代采与挂载

承载部署 agent 的 runner SHALL 在平台缝上接入舰队记忆：回合观测由 manager 以该部署的记忆令牌投递到舰队记忆 capture API——与 usage 事件同缝、不要求 harness 自带 hooks。观测 SHALL 覆盖回合边界与工具调用两层：回合开始（`user-prompt-submit`，携带入站意图摘要）、每次工具调用（`pre-tool-use`，携带 `tool_name` 与参数摘要）、每次工具结果（`post-tool-use`，携带 `tool_name`、结果摘要与错误标记）、回合结束（`stop`，携带结果 / token / 时长）；工具层事件经 harness adapter 的可选事件回调取得（dsh 自 `session.event` 的 `tool/call` / `tool/result`，ACP 自 `session/update` 的 `tool_call` / `tool_call_update`），adapter 不支持该回调时观测退化为仅回合边界而非失败。摘要 MUST 在 runner 侧按部署配置的上限截断、在舰队记忆侧过既有脱敏；capture API 的事件形状不变。

每条观测 MUST 携带产生它的部署的 namespace，批次投递 MUST 按 namespace 分组——同一 runner 托管的多个部署交替产生观测时，任何部署的 namespace 下 MUST 只含该部署自己的事件（跨部署、跨 owner 永不串投）。

部署的运行时组合 SHALL 自动携带舰队记忆的 MCP 挂载（dsh 经 profile patch、ACP 经 session 的 MCP 传递面，令牌解析与既有凭据纪律同源）；persona 记忆纪律文案 MUST 仅在该次组合实际携带记忆挂载时注入——挂载缺席（pod 运行时尚未挂载、令牌铸造失败而降级）时组合 MUST 不含纪律文案，避免引导 agent 调用并不存在的工具。舰队记忆不可达时 MUST 降级开放：回合照常执行与计费，代采暂停且如实记录，恢复后继续——记忆缺失永不阻断服务。

#### Scenario: 同 runner 两部署交替观测各落各自 namespace

- **WHEN** 同一 manager 托管部署 A 与 B，A 产生观测排队后 B 产生观测，随后批次投递
- **THEN** A 的 namespace 批次只含 A 的事件、B 的只含 B 的事件；任一组投递失败只回排该组并计一次缺口，不影响另一组与任何回合

#### Scenario: dsh 部署产生观测与交接

- **WHEN** 一个 dsh 部署跑了数个回合并经 MCP 写出交接
- **THEN** manager 代采的回合观测与该交接都落在该部署的 `d/` namespace，可检索

#### Scenario: dsh 部署一个含工具调用的回合落四形状观测

- **WHEN** 一个 dsh 部署跑一个回合，其中调用了 N 次工具
- **THEN** 该部署 namespace 下按序落 1 条 `user-prompt-submit`（意图摘要）、N 条 `pre-tool-use`（各带 `tool_name` 与参数摘要）、N 条 `post-tool-use`（各带 `tool_name`、结果摘要，失败结果带错误标记）、1 条 `stop`（结果 / token / 时长），每条摘要不超过部署配置的上限

#### Scenario: ACP 部署同样接入

- **WHEN** 一个 ACP harness 部署（如 claude-code）跑回合并调用工具
- **THEN** 其 `tool_call` / `tool_call_update` 经 manager 缝落为同形的 `pre-tool-use` / `post-tool-use` 观测，其 MCP 组合含舰队记忆条目

#### Scenario: 挂载缺席的组合不含纪律文案

- **WHEN** pod 运行时组合（v1 尚无记忆挂载）或 dsh / ACP 组合因令牌铸造失败而无挂载行
- **THEN** 该次组合的 persona 不含记忆纪律文案；同一部署在挂载成功的组合中含该文案

#### Scenario: 记忆面停机不阻断回合

- **WHEN** 舰队记忆服务不可达
- **THEN** 部署回合照常执行、计费照常，manager 记录代采缺口并在服务恢复后继续投递
