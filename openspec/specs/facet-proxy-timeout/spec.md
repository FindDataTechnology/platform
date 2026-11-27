## Purpose

platform 的 facet 代理通道需要按部署环境放宽超时（长 deploy 不被 30 秒默认截断），且必须以 opt-in 环境变量的方式保持未配置部署零行为变化。

## Requirements

### Requirement: Facet 代理超时 opt-in 可配

platform 的 facet 代理通道 SHALL 支持通过 `FACET_PROXY_TIMEOUT_MS` 环境变量放宽请求超时：仅当该值为**正数**时，platform SHALL 把该值作为 `timeoutMs` 传给 `registerFacetProxy`；未配置、非数值、零或负数时 SHALL NOT 传入该键，代理 SHALL 保持既有默认 30 秒。该配置 SHALL 同时作用于所有经代理的 facet 请求（不特例化 deploy），且 SHALL NOT 改变 `facet-proxy.js` 中 `AbortSignal.timeout(timeoutMs)` 的语义。

#### Scenario: 未配置时行为不变

- **WHEN** `FACET_PROXY_TIMEOUT_MS` 未设置
- **THEN** `registerFacetProxy` 的调用不含 `timeoutMs` 键，代理超时为 30 秒，与变更前逐字节一致

#### Scenario: 配置正数时生效

- **WHEN** `FACET_PROXY_TIMEOUT_MS=120000`
- **THEN** 代理请求的 `AbortSignal.timeout` 使用 120000 毫秒，超过 30 秒的 deploy 不再被代理超时截断

#### Scenario: 非法值不生效且不留隐患

- **WHEN** `FACET_PROXY_TIMEOUT_MS` 为 0、负数或非法字符串
- **THEN** 代理回落 30 秒默认，服务正常启动，不抛错

#### Scenario: 去掉配置即回滚

- **WHEN** 部署清单移除该 env 并滚动
- **THEN** 代理超时恢复 30 秒，无需代码回滚

