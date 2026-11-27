# user-llm-providers Specification

## Purpose
TBD - created by archiving change add-user-supplied-credentials. Update Purpose after archive.

## Requirements

### Requirement: 用户可添加自己的模型服务，且只有本人可见

已认证用户 SHALL 能添加自己的模型服务条目（上游 + 凭据），该条目 SHALL 只对该用户
生效，MUST NOT 影响其他用户或改变平台默认路由。平台默认路由 SHALL 继续存在并作为
「未配置用户」的行为。

首版上游 URL SHALL 只能从平台内置清单中选择；凭据由用户填写，且 MUST NOT 回传。

#### Scenario: 用户添加的 provider 只对自己生效
- **WHEN** 用户 A 添加一个 provider 并在会话中使用
- **THEN** A 的模型选择器含该 provider；用户 B 的选择器不含它

#### Scenario: 未配置用户走平台默认
- **WHEN** 用户 C 未添加任何 provider
- **THEN** C 的会话使用平台默认路由（词元），行为与本能力引入前一致

#### Scenario: 凭据不回传
- **WHEN** 前端读取 A 的 provider 列表
- **THEN** 每个条目只含 `hasKey` 等元信息，不含 key 值

### Requirement: 移除用户自己的 provider 立即生效

删除或停用自己的 provider SHALL 使后续请求立即不再使用它，MUST NOT 需要重启运行时。
若该 provider 是当前选中的模型来源，选择 SHALL 回落到平台默认可服务模型，并向用户
如实报告回落。

#### Scenario: 删除后立即不再使用
- **WHEN** 用户删除自己正在使用的 provider
- **THEN** 下一次请求不再使用它；当前选择回落到平台默认并提示

### Requirement: 用户 provider 的地址受统一安全判据约束

用户 provider 的目标地址 SHALL 经过与 MCP 端点覆盖相同的地址安全判据（见
`credential-url-safety`）。首版只允许内置清单意味着该路径暂无自由输入，
但一旦开放自定义地址，MUST 先满足该判据。

#### Scenario: 开放自定义地址前必须先有闸
- **WHEN** 产品决定允许用户填任意上游地址
- **THEN** 该版本 MUST 同时具备地址安全判据与 DNS 复核，否则不得开放
