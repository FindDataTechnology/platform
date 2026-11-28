# line-credentials Specification

## Purpose
壹座侧的各产品线凭据轨道（wire-customer / lex / wanxing-caller 三 ref）：让 dsh 会话以
用户自己的身份调用各线操作 MCP。分两型——**短命 ID token 型**（wire-customer/lex：浏览器
PKCE 静默铸，上游验签，过期省略-重铸）与**长命 key 型**（wanxing-caller：粘贴 sk-，401
stale）。凭据只存服务端、只经注入路径出现。

## Requirements

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

### Requirement: Short-lived ID tokens are omitted when expired and renewed server-side via stored refresh tokens

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
client_id 取自该线 auth config，无 secret、无 redirect_uri）。节奏 SHALL 与 ID token 的
exp 解耦、锚定**上次 rotation 的时间**（refresh token 对服务端不透明、无 exp 可读）：
① 每个排程回合开始前，若距上次 rotation 已超固定节奏（默认 15 分钟）或 ID token 余量
< 30 分钟 SHALL 先续再跑；② 后台巡检（间隔 ≤10 分钟，实测 5 分钟）SHALL 对超节奏行续期。
Logto refresh token 为轮换制——每次刷新返回的新 `refresh_token` SHALL 与新 ID token
**同一行更新原子落库**；同一行的并发续期 SHALL 单飞（只发一次 refresh 请求）。
**周期上限**：SPA 公共客户端的 refresh token 绑定铸币时的浏览器会话且自铸币起为绝对租约
（实测 14 天、rotation 不延长）——续期 SHALL NOT 被理解为无限续命，机制外由周期重铸
（≤13 天）覆盖到达上限前的重建。

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

### Requirement: Line connection routes are token-free

`GET /api/lines/:line/connection` SHALL 返回状态投影（connected/stale/expiresAt/line）；
`POST /api/lines/:line/credential` SHALL 按 line 校验形状（wire/lex=JWT 三段+可解析 exp；
wanxing-caller=`sk-` 前缀）后存储并触发 profile 重应用；未知 line SHALL 404。
`GET /api/lines/:line/mint/start` 与 `GET /api/lines/:line/mint/callback` SHALL 仅服务
wire-customer/lex（其余 404），要求已认证调用者，并以签名状态 cookie 校验 state；callback
SHALL 清除该 cookie。DB 不可用 SHALL 退化为「未连接」。

#### Scenario: 未知线拒绝

- WHEN POST /api/lines/unknown/credential
- THEN 404

#### Scenario: 伪造 state 被拒

- WHEN callback 收到的 state 与签名 cookie 不匹配
- THEN 不发起 code 交换、不落库，落回设置面带错误标记

### Requirement: wanxing-deployer ref for cloud deployment

壹座 SHALL 支持第四类线凭据 ref：`wanxing-deployer`，用于以用户自己的 sub2api `sk-` key 发起云端部署。该 ref SHALL 与 `wanxing-caller` 分立（前者承载被部署服务的自主回合成本，后者承载外部调用回合），MUST NOT 互相复用。粘贴 SHALL 校验 `sk-` 前缀；401 SHALL 置 stale 并提示重贴。该 ref SHALL 仅在 `target=cloud` 的部署 preflight 中被要求；桌面机位部署 MUST NOT 要求该 ref。

#### Scenario: 与 caller 分立

- **WHEN** 用户已连接 wanxing-caller 但未连接 wanxing-deployer
- **THEN** 云端部署 preflight 失败，外部调用回合不受影响

#### Scenario: 桌面部署不要求

- **WHEN** 用户未连接 wanxing-deployer 但机位已配对且在线
- **THEN** 桌面部署 preflight 通过

#### Scenario: 投影无密钥

- **WHEN** 查询 wanxing-deployer 连接状态
- **THEN** 响应只含 connected/stale，不含 sk- 或其片段

### Requirement: Pack installs honor the server's declared line credential ref

wire-customer / lex 条目的 pack 安装与市场卡安装 SHALL 以该线凭据自身的连接状态为闸：
凭据连接则安装，未连接则以 credential-required 拒装——409 文案 SHALL 指名缺的是哪条线
的凭据（不再出现「connect the MCP market first」类误导），connectPath SHALL 指向该线的
连接卡。安装闸 SHALL NOT 将线凭据 ref fall-through 到 registry 凭据判活：没有 registry
（市场）凭据但持有活线凭据的账号 SHALL 能装对应线的 pack；持有 registry 凭据但线凭据
未连接的账号 SHALL 被拒。派发表登记的其余线系 ref（wanxing-caller）SHALL 同理按其凭据
模块判活；registry / facet-market / chatwoot / paper-trading 四既有 ref 的闸行为 SHALL
与本 change 之前完全一致。

#### Scenario: 仅 wire-customer 凭据的账号装 wire pack 成功

- WHEN 一个没有任何 registry 凭据、仅持有活的 wire-customer 凭据的账号安装引用
  wire 线服务器条目的 pack
- THEN 安装成功，该服务器状态 installed，注入的是其 wire-customer 凭据

#### Scenario: 线凭据断开后重装被拒且指向正确入口

- WHEN 该账号断开 wire-customer 凭据后再次安装同一 pack
- THEN 以 credential-required 拒装，文案指名 wire 线凭据缺失，connectPath 指向
  wire-customer 连接卡

#### Scenario: lex 同形

- WHEN 上述两测以 lex 线条目与 lex 凭据重演
- THEN 结果同形（仅凭 lex 凭据可装、断开被拒且指向 lex 连接卡）

#### Scenario: registry 凭据替代不了线凭据

- WHEN 一个仅有活 registry 凭据、无 wire-customer 凭据的账号安装 wire 线 pack
- THEN 以 credential-required 拒装（其 registry 凭据不满足线凭据闸）

#### Scenario: 四既有 ref 闸行为零变化

- WHEN registry / facet-market / chatwoot / paper-trading 四类 ref 的条目在有/无对应
  凭据时分别安装
- THEN 拒装与放行行为与本 change 之前完全一致（含既有文案与 connectPath）

### Requirement: Fleet unattended chains are minted under dedicated service accounts

舰队无人值守 cell 的 wire-customer 链，其 mint 授权主体 SHALL 使用舰队专属服务账号（非人类测试账号）；凭据行的键 SHALL 保持 cell 属主的平台身份（profile 选行语义不变）。即两层身份各司其职：计费/授权归因随 token 主体落服务客户，行键与 cell 归属不因切换而迁移。服务账号 SHALL NOT 用于任何人工交互式登录；除周期重铸机制外任何方改动其口令/禁用位都等价于舰队链全灭。重铸 SHALL 每次使用全新浏览器会话（同会话再授权杀旧链）；以服务账号登录的重铸请求 SHALL 携带工具类 UA（非浏览器 UA），与 wire 侧护栏的告警分类不冲突。

周期重铸机制 SHALL 每轮检查无条件重铸全部在册无人值守行——新授权原子落同一行替换旧链，无服务中断——SHALL NOT 采用「距到期小于固定窗口才触发」类条件：铸币发生在检查相位之间时，任何固定触发窗都存在盖不住绝对租约到点的相位漏洞。

#### Scenario: 切换重铸只动主体不动行键

- **WHEN** 以服务账号完成一次 fleet cell wire-customer 行的重铸
- **THEN** 行键仍为 cell 属主邮箱、cell profile 正常选中新凭据；行内 token 主体=服务账号、stale=0、含 refresh token；上游 grant/billing 归因=服务客户

#### Scenario: 中途铸币的相位也被覆盖

- **WHEN** 某行的铸币时刻不与周期检查点对齐（如切换当日的临时重铸）
- **THEN** 下一轮周期检查仍无条件重铸该行，行龄恒 ≤ 检查周期，绝不跨过绝对租约到点；无「墙后等下轮救回」的空窗

#### Scenario: 重铸登录不触发护栏告警

- **WHEN** 周期重铸以服务账号口令完成一次交互式登录
- **THEN** 该登录携带工具类 UA，wire 侧护栏归为「记录不告警」；人工浏览器登录同账号时护栏按设计告警
