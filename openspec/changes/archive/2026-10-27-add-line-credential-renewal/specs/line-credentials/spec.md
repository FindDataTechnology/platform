# line-credentials Delta

## RENAMED Requirements

### Requirement: Short-lived ID tokens are omitted when expired and re-minted through the user's browser session

- FROM: `Short-lived ID tokens are omitted when expired and re-minted through the user's browser session`
- TO: `Short-lived ID tokens are omitted when expired and renewed server-side via stored refresh tokens`

## MODIFIED Requirements

### Requirement: Short-lived ID tokens are omitted when expired and re-minted through the user's browser session

wire-customer/lex 的 liveToken SHALL 仅在 token 未过期（余量 >0）时返回；过期或缺失 SHALL
返回 null（server 行省略）。

**铸币**：重铸 SHALL 是由用户浏览器会话驱动的授权码往返：浏览器导航到平台的 mint 起点，
Logto 授权并回调**平台自身 origin 的注册回调**，平台以 PKCE 完成 code→token 交换（各线
client 为 SPA 公共客户端，无 client secret）。authorize 请求 SHALL 含 `offline_access`；
token 响应中的 `refresh_token` SHALL 随凭据行存储（与现有 secrets 同级，只写不读——不进
任何投影、响应或日志）。`prompt=none` 因 offline_access 首连触发 consent/login required
时 SHALL 沿既有 interactive 重试一次的路径完成。平台 SHALL NOT 以自身凭据/audience 代铸
ID token；签名/audience/组织门禁判定仍全在上游。跨域读取 SHALL NOT 出现在该链路上。

**续期**：SHALL 在服务端完成，不依赖用户浏览器——refresh grant（`grant_type=refresh_token`，
client_id 取自该线 auth config，无 secret、无 redirect_uri）。两道触发并存：① 每个排程
回合开始前，回合属主的线凭据若 `exp - now < 30min` SHALL 先续再跑；② 后台巡检（间隔
≤10 分钟）SHALL 对将到期行续期。Logto refresh token 为轮换制——每次刷新返回的新
`refresh_token` SHALL 与新 ID token **同一行更新原子落库**；同一行的并发续期 SHALL 单飞
（只发一次 refresh 请求）。

**失效**：refresh 被拒（吊销/改密）SHALL 将行标记 stale（不清行——保留审计与「需重连」
展示），连接卡提示重连；排程回合拿到的是明确的未连接态，而非静默 401。

**401 兜底**：线 MCP 工具结果报 401 时，若行存有 refresh token，平台 SHALL 先尝试一次
续期（当回合已损耗，下一回合自愈）；续期失败或无 refresh token 的行维持原语义——有
refresh 能力的标 stale，纯 ID token 旧行清缓存（浏览器下次访问重铸）。

#### Scenario: 无人值守连续读面

- **WHEN** 排程巡线回合（如每日 09:00）在凭据铸入超过 24 小时后触发，且 refresh 链健康
- **THEN** 回合内线 MCP 调用携带未过期 token（读面 200），全程零浏览器参与

#### Scenario: rotation 原子落库

- **WHEN** 一次续期成功
- **THEN** 新 ID token 与新返回的 refresh_token 在同一次行更新中落库，后续续期使用新
  refresh_token

#### Scenario: 双触发单飞

- **WHEN** 回合前续期与后台巡检几乎同时命中同一将到期行
- **THEN** 该行只发出一次 refresh 请求，两触发共享同一结果

#### Scenario: refresh 失效标 stale

- **WHEN** refresh grant 被拒（用户改密或吊销）
- **THEN** 行标记 stale、连接卡提示重连，下一个排程回合如实报「未接入」而非假成功

#### Scenario: 401 安全网自愈

- **WHEN** 线 MCP 工具结果报 401 且行存有 refresh token
- **THEN** 平台先试一次续期；成功则凭据续期并重应用（下一回合恢复），失败则行翻 stale

#### Scenario: 无 refresh token 的旧行保持旧语义

- **WHEN** 401 到达一行未存 refresh token 的凭据（历史粘贴的 ID token）
- **THEN** 行被清除，浏览器下次访问平台时重铸（原 UX 不变）

#### Scenario: 过期省略与自动恢复

- **WHEN** ID token 过期后发生 profile 写入
- **THEN** server 行省略；有 refresh 能力的行由服务端续期自动恢复（无需任何浏览器参与），
  无 refresh 能力的旧行由用户点击「连接」触发静默重铸（prompt=none）恢复

#### Scenario: 上游验签语义不变

- **WHEN** 注入的 ID token 被 wire/lex 校验
- **THEN** 签名/audience/组织门禁判定全在上游（平台不代判，也不代签）

#### Scenario: 失败诚实回落

- **WHEN** 授权被拒、state 不匹配或交换失败
- **THEN** 浏览器落回设置面并带可读错误标记；响应/日志不含上游 token 材料

#### Scenario: 首连 consent 由 interactive 重试吸收

- **WHEN** 追加 offline_access 后首次 prompt=none 铸币返回 consent_required
- **THEN** 既有 interactive 重试路径完成授权，refresh_token 随回调落库

#### Scenario: 投影与日志无密钥

- **WHEN** 任意连接状态被查询、或续期成功/失败被记录
- **THEN** 响应与日志不含 ID token、refresh token 或其片段；日志只记属主 email、线、结果
