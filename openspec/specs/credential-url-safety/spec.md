# credential-url-safety Specification

## Purpose
TBD - created by archiving change add-user-supplied-credentials. Update Purpose after archive.

## Requirements

### Requirement: 用户可影响的目标地址必须过统一的安全判据

凡目标地址可能由用户提供的路径（自建 LLM 服务、MCP 端点覆盖等），系统 SHALL 在写入
与使用两个时刻都经过同一套地址安全判据。判据 SHALL 至少拒绝：非 http(s) 方案、
回环地址、私有网段、链路本地与云元数据端点、以及本部署的 mesh 网段。

仅写入时校验不构成充分防护（DNS 记录可在写入后改变），使用时刻 SHALL 复核。

#### Scenario: 拒绝云元数据端点
- **WHEN** 用户提交 `http://169.254.169.254/latest/meta-data`
- **THEN** 写入被拒绝，且不产生任何出站请求

#### Scenario: 拒绝本部署 mesh 网段
- **WHEN** 用户提交指向 `100.64.0.0/10` 内某地址的 URL
- **THEN** 写入被拒绝（该网段承载本部署的内网服务，含数据库）

#### Scenario: DNS 解析后复核
- **WHEN** 某域名在写入时解析到公网地址、在使用时解析到私网地址
- **THEN** 使用时被拒绝，不发出携带凭据的请求

### Requirement: 携带凭据的出站请求不得因重定向泄漏凭据

当出站请求携带用户或平台凭据时，重定向 SHALL 要么不跟随，要么在跟随前对新目标重新
执行同一套地址安全判据。MUST NOT 把凭据带到未校验的重定向目标。

#### Scenario: 重定向到内网被拒
- **WHEN** 上游以 302 指向一个私网地址
- **THEN** 不跟随该重定向，请求失败且凭据不外泄

### Requirement: 不允许自由填写 URL 的路径必须先有闸

在地址安全判据落地之前，任何把 URL 输入暴露给用户的界面与接口 MUST NOT 上线；
首版形态 SHALL 只允许从平台内置的上游清单中选择。

#### Scenario: 首版只从内置清单选
- **WHEN** 用户在模型服务页添加第三方上游
- **THEN** 只能从平台内置清单选择，不能输入任意 URL
