# llm-thinking-level Specification

## Purpose
TBD - created by archiving change fix-effort-is-per-model-not-per-provider. Update Purpose after archive.

## Requirements

### Requirement: thinking 级别只属于声明它的模型

thinking 级别（reasoning effort）SHALL 按**模型**归属，MUST NOT 作为 provider 级默认值下发。

- profile SHALL NOT 包含 `providers.<id>.reasoning`：路由级级别会在每次请求组装时作用于该路由下的所有模型，绕过一切运行期校验。
- 级别 SHALL 只随一次具体的模型选择下发（`model/set` 的选择项，或无 `model/set` 时的初始化握手 `effort`）。
- 级别持久化 SHALL 按模型寻址（`llm.effort.<provider>.<model>`）；读取时 MAY 回退到旧键 `llm.effort.<provider>`，但旧键 MUST 只作为一次性迁移源，且 MUST 同样过能力闸门。
- 下发前 SHALL 过唯一闸门：目标模型的 `reasoningEfforts` 未声明该级别（`false`、缺省、空字典三者同义）时，级别 MUST 被丢弃，MUST NOT 被发送。
- 丢弃 SHALL 留痕（命名的通知/日志，说明被丢弃的级别与目标模型），否则"这轮为什么没有 thinking"不可读。
- 读到与目标模型不兼容的持久化级别时 SHALL 清除该值（自愈），MUST NOT 每轮重复丢弃。

#### Scenario: 非推理模型不被别人的级别打挂

- **WHEN** 某路由下既有声明 `high` 的模型，也有声明 `reasoningEfforts: false` 的模型，运维为前者选了 `high`
- **THEN** 后者的请求里 MUST NOT 出现 reasoning 参数
- **AND** 它 SHALL 正常完成，而不是以 `does not support reasoning effort` 失败

#### Scenario: profile 不产生路由级级别

- **WHEN** 存在持久化级别 `llm.effort.volces = high` 并重建 profile
- **THEN** 生成的 profile 里 `providers.volces` 下 MUST NOT 出现 `reasoning:` 字段
- **AND** 该路由下声明了 `high` 的模型仍在选择时收到该级别

#### Scenario: 不兼容的旧键自愈

- **WHEN** 旧键 `llm.effort.<provider>` 的值不被当前落地模型声明
- **THEN** 该轮 MUST 不带级别下发
- **AND** 该键 SHALL 被清除，使后续轮次不再重复丢弃

#### Scenario: 缺省不等于允许

- **WHEN** 目标模型既没有 `reasoningEfforts` 字典也没有 `false`（能力未知）
- **THEN** 级别 MUST 被丢弃（"未知"MUST NOT 被当作"支持"）
