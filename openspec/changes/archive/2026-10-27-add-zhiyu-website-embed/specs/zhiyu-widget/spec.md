## Purpose

萬星·智语二期·托管接待嵌入面：商家把房间嵌进自己的网站，站点访客以 guest 席位与商家的分身/服务智能体同房共话（接待台 2.0）；同机制弱化一档=「授权链接进房」。guest 的账记 host，闸走一期已立的日预算与应答上限。

## ADDED Requirements

### Requirement: 嵌入开关与令牌签署

房间主办 SHALL 能在空间设置里开启嵌入：必须**先提交站点 domain 白名单**（至少一条，至多 ≤10），平台生成一个防猜的 widget 令牌（≥128 bit），签发可复制的 snippet（`<script src="{host}/zhiyu/widget.js" data-room="{token}">` 与其 iframe 直开 URL）。白名单与令牌 SHALL 可随时改配或一键吊销；令牌本身不持久化明文（存哈希）。

#### Scenario: 未设白名单无法开启

- **WHEN** 主办未提交任何域名即请求开启嵌入
- **THEN** 接口以可读原因拒绝，令牌不生

#### Scenario: 休克吊销立即生效

- **WHEN** 主办吊销一个已发放的 widget 令牌
- **THEN** 该令牌其后的首次 widget 加载与任意 API 请求一律 403，原有其他令牌不受影响

### Requirement: widget 公共资源与动态 CSP

平台 SHALL 于 gateway 层提供：加载器脚本 `GET /zhiyu/widget.js`（头等幂、可缓存）与 iframe 页 `GET /zhiyu/embed/:token`。iframe 页响应 SHALL 带 `Content-Security-Policy: frame-ancestors <白名单>`（按令牌所属房间更新）；白名单外域上做嵌套的用户代理 SHALL 被浏览器策略拒绝渲染。加载器与 iframe 之间 SHALL 只经 origin 校验过的 `postMessage` 通信。

#### Scenario: 白名单内嵌入成功加载

- **WHEN** 一名站点访客从白名单 host 打开含 snippet 的页面
- **THEN** 加载器注入 iframe，iframe 以 200 加载房间精简壳

#### Scenario: 白名单外同代码无法装框

- **WHEN** 同一 snippet 出现在白名单外的域上
- **THEN** iframe 响应的 frame-ancestors 不含该域，浏览器侧拒绝渲染（且 API 侧同令牌方可拒绝）

### Requirement: 游客席位的铸造与续访

首次加载时 iframe 客户端 SHALL 通过公开端点铸一个 guest 席位：平台签 zy_guest 令牌（cookie `SameSite=None; Secure;sameSite=None` 与 URL `tty` 兜底双轨），在房间落 kind=guest 成员（join_from 历史授权）；续访凭同一令牌 SHALL 继续发言与读自己的消息流（重新接入同席位）。guest 令牌 SHALL 不含访客任何 PII，仅存 32-bit 匿名代号（可显示为站点前缀+序号，如「访客 · A3F2」）。

#### Scenario: 刷新页面仍是同一访客

- **WHEN** 一名访客刷新嵌入页
- **THEN** 其 guest 席位被复用，续接上自己的消息流（不会生成第二个席位）

#### Scenario: URL 令牌兜底无第三方 cookie

- **WHEN** 访客的浏览器拒绝第三方 cookie
- **THEN** 客户端经 URL `tty` 完成同样的铸造与续访，能力不降级

### Requirement: 身份声明升级（identify）

宿主页面 SHALL 能通过 `postMessage` API `identify({ email, secret, ts, displayName })` 升级：平台校验该房间站点密钥（**bearer 出示 + 哈希比对，时间窗 + nonce 一次性防重放**），成立后将 guest 席位**并轨**为登录成员：历史消息归属保留，新消息以该成员身份发送，guest 令牌作废。验证失败 SHALL 一律同形拒绝且不泄露存在性。

#### Scenario: 登录客户接入历史会话

- **WHEN** 站点登录用户通过 identify 声明身份
- **THEN** 原 guest 消息流以新身份继续，此前其 guest 发言仍归其名下展示

### Requirement: guest 参与规则（单方收紧）

guest 成员 SHALL：读自加入起的共享历史与自发言回执；以**人类消息触发**（一期回合路由未变——@定向/广播可过/回复不连环/上限）获取应答。guest SHALL NOT：邀请/移除成员、改造空间设置、读取任何私窗消息、绕过房间白名单加载。guest 消息触发的回合计入所在房间每消息应答上限与每座位并发闸。

#### Scenario: guest 点名智能体被应答

- **WHEN** guest 发送「@接待分身 你好」
- **THEN** 仅该智能体应答，人类消息通道小计费轮次启动

#### Scenario: guest 不可见私窗

- **WHEN** 主办与其分身在私窗交谈
- **THEN** guest 的消息流不含任何私窗行

### Requirement: 计费归属与熔断

guest 触发而发言的座位应答 SHALL 按该座位的部署计费键结算（usage id 后缀 guest scope）；guest 自身发送与人类参与零计费；pass 与失败零计费（沿用一期规则）。房间**日预算闸与应答上限**对 guest 流量同样强制；预算触顶时 guest 看见如实状态而非伪失败。

#### Scenario: 预算触顶时 guest 得到如实提示

- **WHEN** 房间当日应答预算已尽，guest 再发消息
- **THEN** 流内呈现「已达每日发言预算」的系统事件而非应答

### Requirement: 限速与关停

widget 加载与 guest 消息 SHALL 分别限速（每 IP/每席位每秒窗）；超限 SHALL 以 429 与节流文案回答，不影响他人节流桶。主办关停嵌入或整房间结束时，widget SHALL 在下一次加载或事件流中如实落幕（不再接受新消息）。

#### Scenario: 消息刷过速度成为攻击

- **WHEN** 单一访客高频连发消息
- **THEN** 触及限流阈值后其新消息 429，其余访客与在席成员无感

### Requirement: 授权链接进房（弱化档）

平台 SHALL 给主办一键生成「可分享进房链接」的能力：不带 iframe 包装，以同令牌体系打开完整空间页（体验=站内房间视图）。白名单不适用于链接本身；持链接者即以 guest 席位进房（声明鉴权），其他参与规则与计费与 widget 一致。

#### Scenario: 店主把链接发给熟人请其进房

- **WHEN** 无站点访客身份的人打开该链接
- **THEN** 其成为 guest 席位，与在场分身对话，历史只见加入之后

### Requirement: 站内嵌入管理面

空间设置面板 SHALL 提供嵌入管理：开/关、白名单编辑、复制 snippet、吊销令牌、查看现行 widget 令牌状态（指纹+创建时间），widget 房间页 SHALL 以横幅明示「你是访客身份，由 <host> 的值守分身接待」。

#### Scenario: visitor 进房看到接待横幅

- **WHEN** guest 第一次进入嵌入房间
- **THEN** 页头呈现其访客身份与接待方说明，不伪造真人身份
