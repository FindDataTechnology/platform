## ADDED Requirements

### Requirement: 卸载包后其绑定行转为历史

卸载一个包 SHALL 把该包在 `connector_binding_ledger` 里的一切行置为 `deprecated`，对每个曾
持有该包绑定行的身份都生效；这些行此后 SHALL NOT 计入 `GET /api/connections` 的 `bindings`、
`bindingSummary.packs` 或 `unresolved`，也 SHALL NOT 产生注入行或可点动作。

卸载 SHALL NOT 删除或吊销该包绑定的已授予令牌：卸载是「这个包不再装了」，不是「撤销用户授权」；
重装同一个包时既有授权 SHALL 仍然可用。

卸载 SHALL NOT 影响其他包的台账行。

#### Scenario: 卸载后卡片不再报待办

- **WHEN** 一个包声明了 `connector_bindings` 且已安装，某身份已有其台账行（任意状态）
- **AND** 该包被卸载
- **THEN** 该身份的这些台账行状态为 `deprecated`
- **AND** `/api/connections` 的 `bindings` 中不再出现该包的行，`unresolved` 不因它计数

#### Scenario: 卸载不吊销凭证，也不误伤别的包

- **WHEN** 卸载该包时它已有一条 `kind='binding'` 的槽令牌，且同一身份还有另一个包的绑定行
- **THEN** 槽令牌仍可读到（内容不变），另一个包的行状态不变

#### Scenario: 二次卸载被拒且不改状态

- **WHEN** 对一个已卸载的包再次调用卸载
- **THEN** 调用被拒绝（`Pack not installed`），已有 `deprecated` 行保持 `deprecated`
