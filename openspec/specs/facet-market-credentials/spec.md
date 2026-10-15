# facet-market-credentials Specification

## Purpose

壹座侧的谦面市场设备凭据：每 identity 一台设备身份（Ed25519 密钥），经 facet 既有
device-pairing-auth 协议配对后**静默续登铸造短命 app token**（TTL 12h），在每次有效
profile 写入时注入 facet-market MCP 服务行的 Authorization 头——使 dsh 会话能以用户
自己的市场身份操作谦面市场（发布/浏览/策展）。终牌不落库（过期即废），设备私钥与
token 只存服务端。

## Requirements

### Requirement: Device identity is stored per user and never exposed

壹座 SHALL 按 identity（hosted=登录邮箱，auth off=machine-owner）存至多一台设备身份：
deviceId、Ed25519 密钥对、facet 侧账号、配对时间、stale 标记与 token 缓存（含 exp）。
任何 HTTP 响应、日志或错误消息 SHALL NOT 包含私钥、token 明文或其前缀片段；状态投影
只含 connected/paired、stale、facet 账号、pairedAt 与 token 过期时刻。DB 不可用 SHALL
退化为「未连接」而非报错炸面。

#### Scenario: 粘贴不可能，配对才成立

- WHEN 用户尚未配对而查看状态
- THEN 投影报告未连接，且不存在任何「粘贴 token」入口——凭据只能经配对流建立

#### Scenario: 密钥不出库

- WHEN 任意 API 被调用或服务报错
- THEN 输出不含私钥与 token 材料

### Requirement: Pairing redeems a bind code and persists the device binding

`POST /api/facet-market/pair`（绑定码）SHALL 以 6 位绑定码走 facet `POST /api/app/pair`
（deviceId+raw32B base64url 公钥+label「壹座·谦面市场」）；成功 SHALL 持久化设备身份并
以返回 token 验证存缓存；facet 侧 400/401 SHALL 原语义透传给面板且不落任何本地行。
同 identity 重复配对 SHALL 整体替换设备身份（旧设备的吊销交 facet 侧设备管理）。

#### Scenario: 配对成功即连接

- WHEN 用户提交有效绑定码
- THEN 状态投影变为已连接（含 facet 账号与 token 过期时刻），下一次有效 profile 写入注入新凭据

#### Scenario: 错误绑定码不落库

- WHEN facet 对 pair 应答 401（码错/过期/已用）
- THEN 面板收到该错误，本地无设备行、无缓存

### Requirement: Tokens are minted silently and injected on profile writes

`liveToken(email)` SHALL 同步返回缓存 token，其 exp 余量 >10 分钟；余量不足或缓存为空时
SHALL 返回现有值（可为 null）并异步触发 `ensureFresh`——challenge→Ed25519 签
`deviceId:nonce`→login 铸新缓存。ensureFresh SHALL per-identity 串行（挑战槽单占用）。
注入 SHALL 只发生在有效 profile 写入（credentialRef=facet-market 的服务行）；
无可用 token（未配对/stale/缓存空）时该服务行 SHALL 被省略并留一条按 ref 聚合的告警。

#### Scenario: 过期前静默续登

- WHEN 缓存 token 余量 <10 分钟且发生 profile 写入
- THEN 本次写入注入现有 token，后台完成续登，下次写入拿到新 token

#### Scenario: 并发写入只铸一次

- WHEN 多个写入同时触发 ensureFresh
- THEN 恰好一轮 challenge/login 发生（串行锁），全部写入最终拿到同一新 token

### Requirement: 401 flips stale with auto-recovery, revocation requires re-pair

facet 判 401 时 `markInvalid(email)` SHALL 清 token 缓存并置 stale（状态翻转返回 true
——恰一次重应用，与 registry/connector 同契约）。恢复 SHALL 自动：下一次写入触发静默
重登，成功即清 stale 回连接态。重登 401 `binding_required`（设备被吊销）SHALL 保持
stale 并在面板提示重新配对；网络失败/5xx SHALL 不动缓存（照存纪律）。

#### Scenario: token 过期中段翻面自愈

- WHEN 注入的 token 过期导致 401
- THEN 翻面恰一次，随后 ensureFresh 重登成功，连接态自动恢复

#### Scenario: 设备被吊销不自愈

- WHEN facet 侧吊销了该设备绑定
- THEN 每次重登 401，stale 保持，面板提示重新配对

### Requirement: Disconnect drops the row and best-effort revokes

`DELETE /api/facet-market/connection` SHALL 删除本地设备行（下次写入省略该服务）并以
现存 token best-effort 调 facet `DELETE /api/app/bind/:deviceId`；吊销失败 SHALL NOT
阻断本地删除。

#### Scenario: 断开即省略

- WHEN 用户断开且发生 profile 写入
- THEN facet-market 服务行从有效 profile 省略

### Requirement: Pack installs honor the server's declared credential ref

registry 来源 MCP 的安装 SHALL 取 `entry.metadata.credential_ref ?? "registry"` 作为
credentialRef；对应凭据未连接（facet-market 未配对或 registry 未连接）SHALL 以
credential-required 拒装并指明连接入口，装好的行为现状不变。

#### Scenario: facet-market 条目要求 facet-market 凭据

- WHEN 用户安装引用 facet-market-mcp 条目的 pack 而未配对市场
- THEN 安装被拒（credential-required，指明去设置配对），已配对则装为 credentialRef=facet-market
