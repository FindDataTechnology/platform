# user-mcp-endpoints Specification

## Purpose
TBD - created by archiving change add-user-supplied-credentials. Update Purpose after archive.

## Requirements

### Requirement: MCP 端点覆盖以 server 能力声明为前提

MCP server 条目的目标地址 SHALL 只有在**该 server 声明允许端点覆盖**时才可由用户改写。
未声明的 server MUST NOT 接受用户提供的地址，其地址 SHALL 恒为平台登记值。

声明缺失 SHALL 视为「不允许」——默认关闭。

理由：地址一旦按用户变化，registry 侧基于平台地址的探针与在册一致性判据就不再代表
用户实际所连的目标；不设开关会让那些判据变成假绿。

#### Scenario: 未声明的 server 不可覆盖
- **WHEN** 某 server 未声明 `endpointOverridable`
- **THEN** 用户界面不提供地址输入，接口拒绝地址字段

#### Scenario: 已声明的 server 可覆盖
- **WHEN** 某 server 声明 `endpointOverridable: true`
- **THEN** 用户可填写自己的端点，且该值经过统一地址安全判据

### Requirement: 允许覆盖的 server 从平台侧一致性判据中排除

对声明了端点覆盖的 server，平台侧「登记地址与实际所连一致」的判据 SHALL 改为
「平台默认地址可达」+「至少一个用户覆盖端点可达」的形式。MUST NOT 继续用
「登记地址 == 用户所连地址」判定，否则判据必然报假漂移或假绿。

#### Scenario: 覆盖后不报假漂移
- **WHEN** 某可覆盖 server 的用户使用了自己的端点
- **THEN** 平台侧一致性检查不报「登记地址与实际不符」，而是按可覆盖口径判定

### Requirement: 按工具的凭据覆盖以 server 能力声明为前提且如实标注

工具级凭据覆盖 SHALL 只对声明了 tool 级能力（`credentialScopes` 含 `tool`）的 server
开放。对未声明的 server，界面 SHALL 明确标注「该服务不支持按工具配置」，
MUST NOT 静默接受配置后不生效。

MCP 协议的连接粒度是「一个 server 一套请求头」，因此工具级覆盖是否真能生效取决于该
server 自身是否接受多份凭据；平台 MUST NOT 假定其生效。

#### Scenario: 不支持的 server 如实标注
- **WHEN** 用户查看某未声明 tool 能力的 server 的凭据设置
- **THEN** 界面显示「不支持按工具配置」，且没有可提交的工具级输入

#### Scenario: 支持的 server 允许工具级覆盖
- **WHEN** 某 server 声明 `credentialScopes` 含 `tool`
- **THEN** 用户可为单个工具配置覆盖，且该值按级联解析优先于 server 与 user 层
