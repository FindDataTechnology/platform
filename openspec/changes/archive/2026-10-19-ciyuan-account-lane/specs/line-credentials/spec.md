# line-credentials Delta

## MODIFIED Requirements

### Requirement: Three line refs with type-specific lifecycle

壹座 SHALL 按 (identity, line) 各存一份凭据：line=wire-customer/lex 存 ID token（JWT，
含 exp），line=wanxing-caller 存 `sk-` key。wanxing-caller 的活 token SHALL 以词元账号
（`ciyuan-account`）绑定的 key 为优先来源，身份无账号绑定时以历史手贴 key 兜底（零迁移）。
任何响应/日志 SHALL NOT 含 token 明文或 sk- 前缀片段；投影只含 connected/stale/expiresAt。
无凭据时对应 MCP server 行 SHALL 被省略并留按 ref 聚合的告警。

#### Scenario: 投影无密钥

- WHEN 任意连接状态被查询
- THEN 响应不含 ID token、sk- 或其片段

#### Scenario: 账号 key 优先于手贴 key

- WHEN 同一身份既绑定词元账号又存有历史手贴 wanxing-caller key
- THEN wanxing-caller 的 MCP server 行注入账号 key

### Requirement: wanxing-caller paste semantics mirror the connector family

wanxing-caller SHALL 以 `sk-` 前缀校验粘贴（计费面板自铸的长命 key）；粘贴入口 SHALL 作为
词元账号卡上的次级入口存在（词元登录不可用时的逃生口），不再是产品线操作卡的一行。401
SHALL 置 stale 并提示重连/重贴（网络失败不动缓存）。turn 工具经此凭据的计费边界结算语义
不变——凭据注入不改变 caller 的计费身份。

#### Scenario: 断开即省略

- WHEN 用户断开任意 line 且发生 profile 写入
- THEN 对应 server 行省略

#### Scenario: 粘贴入口在词元账号卡

- WHEN 用户打开连接分节
- THEN 产品线操作卡只含 wire 与 lex 两行；`sk-` 粘贴入口位于萬星·词元卡
