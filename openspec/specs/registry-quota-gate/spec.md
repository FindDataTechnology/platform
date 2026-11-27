# registry-quota-gate Specification

## Purpose

registry 预检层 wire 当月行数门的行为契约：门的管辖作用域（哪些 server 归 wire 线管）、线内 verdict 教义（fail-closed 边界）、与余额门的条件关系、以及 mcp-proxy 跳拒绝审计的最终局语义。本能力首版即含作用域语义（fix-quota-gate-server-scope 收口跨线误伤事故）。

## Requirements

### Requirement: 行数门的管辖作用域由 server 名单界定

行数门 SHALL 仅对名单内的 registered server 生效。配置面为 `FD_WIRE_QUOTA_SERVERS`（registered server 名单）：未设时门对全部 server 生效（既有行为，向后兼容）；设定时门只对名单内 server 生效，名单外 server 的已映射非 admin caller SHALL 完全跳过行数门（不探测 wire 额度端点、不产生 `MONTHLY_QUOTA_EXHAUSTED` / `QUOTA_UNAVAILABLE` 拒绝）。非 wire 线的客户无需在 wire 额度面存在映射即可使用本线的 server。

#### Scenario: 名单外 server 的 lex 客户直连入口恢复

- **WHEN** lex 客户 key（caller map 中有 sub2api 映射、wire 额度面无此客户）调用名单外 server 的直连入口 initialize
- **THEN** 请求不被行数门拦截（不再是 503 QUOTA_UNAVAILABLE），按其余准入门的正常语义返回

#### Scenario: 名单内 wire server 的行数门不回归

- **WHEN** wire 客户（wire 额度面真实客户）调用名单内 wire server
- **THEN** 行数门照常探测 verdict：额度内放行、超额 402 MONTHLY_QUOTA_EXHAUSTED、额度面不可达 503 QUOTA_UNAVAILABLE

#### Scenario: 名单未设时维持现状

- **WHEN** `FD_WIRE_QUOTA_SERVERS` 未设且行数门总闸开启
- **THEN** 门对全部 server 生效（与引入作用域之前的行为逐字节一致）

### Requirement: 名单匹配以 registered server name 为键

作用域匹配 SHALL 以 registered server name 为键：取 proxy path 首段并剥去尾部 transport 段（`mcp` / `sse` / `messages`），federated 形如 `peer/server` 的键保持完整。匹配语义 SHALL 与 /validate 侧 scope 授权使用的 server name 归一规则一致，两跳不得对各自身处的同一 server 得出不同的归一结果。

#### Scenario: transport 后缀剥除

- **WHEN** 调用抵达 `/mcp-proxy/fd-legal-search-mcp/mcp` 而名单含 `fd-legal-search-mcp`
- **THEN** 该 server 视为名单内（行数门生效）；名单不含时视为名单外（豁免）

#### Scenario: federated 键完整保留

- **WHEN** 调用抵达 federated server（proxy path 形如 `peer-name/server-name/mcp`）
- **THEN** 匹配键为 `peer-name/server-name`，不因 transport 段误判

### Requirement: 作用域豁免不改变余额门

行数门的作用域豁免 SHALL NOT 影响余额门：名单外 server 的已映射 caller 仍按既有语义接受余额探测——余额耗尽 402 `INSUFFICIENT_BALANCE`，计费面不可达按 PREFLIGHT_MODE 语义处理。名单内 wire server 的档位语义（`enforce_balance=false` 时跳过余额门，free 档 0 余额放行）SHALL 保持不变。

#### Scenario: lex 客户余额耗尽仍被拦

- **WHEN** lex 客户余额耗尽时调用直连入口（名单外 server）
- **THEN** 请求被余额门以 402 `INSUFFICIENT_BALANCE` 拒绝，作用域豁免不构成绕过

#### Scenario: wire free 档 0 余额不受影响

- **WHEN** wire free 档客户（enforce_balance=false）调用名单内 wire server 且余额为 0
- **THEN** 请求放行（200），档位语义不因作用域改造而变化

### Requirement: 线内 fail-closed 教义不变

对名单内 server，行数门的 verdict 教义 SHALL 维持原样：wire 额度端点返回非 200（含未知客户 404、内部令牌被拒）、网络错误、超时或响应形状不符，一律判 `QUOTA_UNAVAILABLE` 并无条件 503 fail-closed（不受 PREFLIGHT_MODE 影响）；caller map 值为 key 形而非 sub2api user id 时同样 fail-closed。

#### Scenario: 名单内 server 的额度面 404 仍拒绝

- **WHEN** wire 客户调用名单内 server 而 wire 额度端点对其返回 404（真实配置缺口）
- **THEN** 请求被 503 QUOTA_UNAVAILABLE 拒绝（fail-closed，不静默放行）

### Requirement: mcp-proxy 跳的拒绝写最终局审计

`/mcp-proxy` 跳上任一准入门（preflight、tier、scope 授权、call-grant）拒绝请求时，registry 审计流 SHALL 在拒绝时刻写入该请求的最终局记录：携带与 `/validate` 审计相同的请求身份关联键、status=refused 及机器可读 error_code。`/validate` 既有审计行为 SHALL 保持不变（虚拟路径依赖它作为唯一审计来源）。对账语义 SHALL 取同一请求的最终局记录，而非先行的鉴权 success 记录。

#### Scenario: 被拒调用留有 refused 记录

- **WHEN** 已映射非 admin caller 的请求在 /mcp-proxy 跳被行数门以 503 QUOTA_UNAVAILABLE 拒绝
- **THEN** 审计流中该请求同时存在 /validate 的 success 记录与 mcp-proxy 跳的 refused 记录（error_code=QUOTA_UNAVAILABLE），对账取 refused 记录

#### Scenario: 拒绝路径不产生上游转发

- **WHEN** 请求在 /mcp-proxy 跳被任一准入门拒绝
- **THEN** 该请求不得到达上游 server（后端无对应 POST），亦不得在上游侧产生计量用量
