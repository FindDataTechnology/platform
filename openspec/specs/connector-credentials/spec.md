# connector-credentials Specification

## Purpose
壹座侧的萬星 connector 凭据：用户把 connector 铸造的 PAT 粘贴进壹座后，它按用户存储、只写不读地暴露状态，并在每次有效 profile 写入时注入到 connector MCP 服务行的 Authorization 头，使 dsh 会话能以用户自己的身份使用 connector 里保存的 SaaS 连接。

## Requirements

### Requirement: Per-user connector credential storage

壹座 SHALL 按用户身份（hosted 模式为登录邮箱，auth off 为 machine-owner）存储**一份或多份** connector PAT，每份以用户可读的账号名（account name）标识，包含 token、账号名与更新时间，零粘贴路径 SHALL 另存铸造返回的 PAT id；同一用户的账号名 SHALL 唯一，同名提交 SHALL 替换该账号的 token 而非新增。用户 SHALL 至多有一个**活跃账号**（active account）：有效 profile 写入时只注入活跃账号的 token；用户 SHALL 能显式切换活跃账号，但平台 SHALL NOT 在任何情况下自动改选（活跃账号被删除或失效后回到无活跃状态，connector 服务从有效 profile 省略，直到用户显式选择）。存储 SHALL 复用与 registry 凭据相同的键控与退化规则，SHALL NOT 因用户未连接而创建占位行；已有单账号数据 SHALL 平滑迁为账号名 `default` 且保持活跃，不丢失既有连接。

#### Scenario: 粘贴即连接

- **WHEN** 已登录用户提交一个非空 PAT
- **THEN** 该用户名下出现 connector 凭据行，状态投影报告已连接与更新时间
- **AND** 同一用户的后续读取返回已连接状态

#### Scenario: 各用户互不可见

- **WHEN** 用户 A 已连接而用户 B 未连接
- **THEN** B 的状态投影报告未连接，B 的任何请求都不会读到 A 的 token

#### Scenario: auth off 退化为机器所有者

- **WHEN** 部署未启用认证（桌面/开发）且用户提交 PAT
- **THEN** 凭据以 machine-owner 键存储，读取与注入使用同一键

#### Scenario: 多账号并存

- **WHEN** 已连接用户以另一个账号名提交第二个 PAT
- **THEN** 该用户名下同时存在两份凭据，各自独立报告状态与更新时间
- **AND** 先前账号的凭据不被覆盖

#### Scenario: 同名账号重连即替换

- **WHEN** 用户以已存在的账号名提交新 PAT
- **THEN** 该账号的 token、PAT id 与更新时间被替换，失效标记清除，账号数量不变

#### Scenario: 活跃账号唯一且决定注入

- **WHEN** 用户持有多个账号并切换活跃账号
- **THEN** 下一次有效 profile 写入只注入活跃账号的 token（connector MCP 服务的 Authorization 头随之变化），非活跃账号不注入也不从存储移除

#### Scenario: 删除活跃账号后回到无活跃

- **WHEN** 用户断开当前活跃账号且名下还有其他账号
- **THEN** 平台不自动改选任何账号，该用户回到无活跃状态，connector 服务从有效 profile 省略，状态面提示用户显式选择
- **WHEN** 用户断开最后一个账号
- **THEN** 状态投影回到未连接

#### Scenario: 断开或替换即 best-effort 吊销

- **WHEN** 用户断开一个零粘贴连接的账号，或同名重连替换其旧 token，且壹座存有该 PAT 的 id
- **THEN** 壹座后端以所存 token 为 Bearer 调 connector 既有 PAT 撤销端点做 best-effort 吊销；吊销失败（404/401/网络错误）不阻断本地删除或替换
- **AND** 手工粘贴的账号（无 PAT id）不发起吊销，维持既有行为

### Requirement: Connector credential is write-only from the client

任何 HTTP 响应 SHALL NOT 包含 PAT 明文或其任何前缀片段；凭据端点只返回连接状态、更新时间与断开标记。日志与错误消息同样 SHALL NOT 回显 token。

#### Scenario: 状态响应不含 token

- **WHEN** 客户端读取 connector 凭据状态
- **THEN** 响应体只含 connected / updatedAt / stale 等投影字段，不含 token

#### Scenario: 错误路径不回显

- **WHEN** 提交的 PAT 被拒绝或存储失败
- **THEN** 错误响应与日志中都不出现所提交的 token 内容

### Requirement: Disconnect removes the credential

用户 SHALL 能断开 connector：断开后该用户的凭据行不再存在，状态投影回到未连接，且下一次 profile 写入不再注入 connector 头。

#### Scenario: 断开后状态归零

- **WHEN** 已连接用户请求断开
- **THEN** 凭据被删除，状态投影报告未连接

#### Scenario: 断开后服务消失

- **WHEN** 用户在已安装 connector MCP 服务的情况下断开凭据
- **THEN** 下一次有效 profile 写入省略该服务，其安装记录保留

### Requirement: Connector credential API is owner-scoped

凭据的读状态/写入/清除端点 SHALL 只作用于请求身份自己的凭据；hosted 模式下匿名请求 SHALL 被拒绝（401），未启用认证时 SHALL 落到 machine-owner。

#### Scenario: 匿名写入被拒

- **WHEN** hosted 模式下未认证请求尝试写入 connector 凭据
- **THEN** 返回 401 且不产生任何凭据行

#### Scenario: 认证用户只能改自己的

- **WHEN** 用户 A 提交写入或清除
- **THEN** 变更只落在 A 的名下，B 的凭据不受影响

### Requirement: Settings panel entry for the connector credential

设置面 SHALL 提供一个 connector 凭据卡片：可粘贴 PAT、显示已连接/未连接状态与更新时间、可断开，并在未连接时说明 PAT 从何处获取（connector 的「我的连接」页面）。卡片 SHALL 在已连接与未连接两态都提供「打开连接器控制台」入口（新标签打开 connector 的 `/me` 用户面板——未连接态是指引终点，已连接态是管理入口）；入口地址 SHALL 取自部署基线中 connector 服务行的 origin + `/me`（与粘贴探活同源，不另行硬编码），基线无该行时入口隐藏、指引降级为纯文案。卡片 SHALL 在标题下常显一句产品说明（连接器是什么、令牌给谁用）与「了解产品」链接——链接 SHALL 新标签打开官网产品介绍页并按界面语言选页（zh 系语言指中文页，其余语言指英文页）。持有多个账号时，卡片 SHALL 以账号列表呈现：每行显示账号名、连接状态与更新时间，并标出当前活跃账号；每行 SHALL 可单独断开，非失效账号 SHALL 可切换为活跃，**失效（stale）账号行 SHALL NOT 提供「设为活跃」、只提供「重连」**（重新建立该账号，见零粘贴流）；无活跃账号时（活跃账号被删后）卡片 SHALL 提示用户显式选择一个账号。卡片 SHALL 提供「连接新账号」入口（承载零粘贴连接流，见下条需求），并 SHALL 常驻保留折叠的手工粘贴次级入口。

#### Scenario: 未连接时可粘贴

- **WHEN** 用户打开设置面且尚无 connector 凭据
- **THEN** 卡片显示未连接与获取 PAT 的指引，并提供粘贴入口

#### Scenario: 已连接时显示状态并可断开

- **WHEN** 用户已连接
- **THEN** 卡片显示已连接与更新时间，并提供断开操作

#### Scenario: 控制台入口两态常显

- **WHEN** 用户查看 connector 凭据卡片，无论已连接或未连接
- **THEN** 卡片提供「打开连接器控制台」入口，新标签打开 connector 的 `/me` 用户面板

#### Scenario: 入口地址来自部署基线

- **WHEN** 部署基线的 mcp.json 存在 connector 服务行
- **THEN** 入口地址为该行 url 的 origin 拼 `/me`，且凭据状态端点的投影携带该地址
- **WHEN** 基线无 connector 服务行
- **THEN** 入口隐藏，卡片指引降级为纯文案（不渲染死链或硬编码域名）

#### Scenario: 卡片产品说明与了解产品链接

- **WHEN** 用户查看 connector 凭据卡片（无论已连接或未连接）
- **THEN** 标题下呈现一句产品说明（连接器是什么、令牌给谁用）与「了解产品」链接
- **AND** 链接新标签打开官网产品介绍页，按界面语言选页（zh 系指中文页，其余指英文页）

#### Scenario: 多账号列表

- **WHEN** 用户持有多个 connector 账号
- **THEN** 卡片逐行列出账号名、连接状态与更新时间，并标记当前活跃账号
- **AND** 每行提供独立断开操作，任一账号的失效状态只体现在该行

#### Scenario: 切换活跃账号

- **WHEN** 用户在卡片中把另一个非失效账号设为活跃
- **THEN** 活跃标记转移，connector 凭据按新活跃账号重新注入（无需重装 MCP 服务）

#### Scenario: 失效账号行只给重连

- **WHEN** 某账号被标记失效（stale）
- **THEN** 该行不提供「设为活跃」，提供「重连」入口；重连成功（同账号名新 PAT）后失效清除，可再设为活跃

#### Scenario: 连接新账号入口

- **WHEN** 用户查看卡片（无论是否已有账号）
- **THEN** 卡片提供「连接新账号」入口，用于新增一个账号而非替换现有账号；手工粘贴以折叠的次级入口常驻保留

### Requirement: Paste-time validation rejects malformed or dead PATs

粘贴端点 SHALL 校验 PAT 形状与存活：非 `oct_` 前缀的提交 SHALL 被拒收（400，指明不是 connector PAT）；形状合法的 PAT SHALL 对 connector MCP 入口做一次探活（Authorization 头携带该 PAT），探活返回 401 时 SHALL 拒收（400，指明 token 已失效或错误），网络错误或服务端 5xx 时 SHALL 照常存储。探活目标 SHALL 取自部署基线中 connector 服务行的 url，不另行硬编码；基线无该行时 SHALL 跳过探活仅做形状校验。

#### Scenario: 非法前缀当场拒收

- **WHEN** 用户粘贴一个不以 `oct_` 开头的字符串
- **THEN** 返回 400 且指明不是 connector PAT，不产生凭据行

#### Scenario: 已撤销 PAT 当场拒收

- **WHEN** 用户粘贴一个形状合法但已被撤销的 PAT，且探活返回 401
- **THEN** 返回 400 且指明 token 已失效或错误，不产生凭据行

#### Scenario: connector 不可达不阻断录入

- **WHEN** 探活因网络错误或服务端 5xx 失败
- **THEN** PAT 照常存储，凭据行建立

### Requirement: Revoked PAT is surfaced and the server is dropped

当已存储 PAT 失效（用户在 connector 侧撤销）而会话中的 connector 工具调用返回 401 时，平台 SHALL 把**该 PAT 所属的那个账号**标记为失效（不删除行）、从有效 profile 省略 connector 服务并重新应用，且一轮连续 401 只触发一次重新应用；其他账号的状态 SHALL NOT 受影响。失效状态 SHALL 投影到凭据状态面并广播给已连接的客户端；用户为该账号重新提供有效 PAT（重粘或零粘贴重连）即恢复，无需重装服务。

#### Scenario: 401 翻面恰好一次重应用

- **WHEN** 已连接用户的 connector 工具调用连续返回 401
- **THEN** 凭据被标记失效，connector 服务从有效 profile 省略并重新应用一次（后续 401 不再重复触发）
- **AND** 状态投影报告已失效，客户端收到凭据失效广播

#### Scenario: 重粘即恢复

- **WHEN** 失效用户重新粘贴一个有效 PAT，或经零粘贴流重连同一账号
- **THEN** 失效标记随存储清除，下一次 profile 写入重新注入 connector 服务，无需重装

#### Scenario: 失效只落在所用账号

- **WHEN** 用户持有多个账号，其中一个账号的 PAT 被撤销并触发 401
- **THEN** 只有该账号被标记失效，其他账号保持已连接
- **AND** 若失效账号正是活跃账号，平台 SHALL 从有效 profile 省略 connector 服务；用户切换到另一个有效账号即恢复注入

### Requirement: Zero-paste connector connect flow

壹座 SHALL 提供零粘贴的 connector 连接流，使已登录连接器的用户无需手工复制 PAT 或输入账号名即可建立账号：用户在卡片点「连接新账号」后，平台 SHALL 探测 connector 会话（探测响应携带登录身份 email/displayName），浏览器尚无会话时 SHALL 打开 connector 的 OIDC 登录页（登录回调重发会话 cookie，使旧策略烙的 cookie 不构成死锁），会话就绪后 SHALL 经 connector 的跨域铸牌端点铸一枚新 PAT，并直接按登录身份自动命名的账号名存入该用户名下、刷新有效 profile。全程 SHALL NOT 要求用户查看、复制或粘贴 token，也 SHALL NOT 要求用户输入账号名（身份无 email 时退化到显示名，再退化到「身份N」）。该流 SHALL 依赖部署侧两个前提：connector 服务行存在于部署基线，且 connector 部署允许壹座 origin 跨域铸牌；任一前提不满足时 SHALL NOT 呈现「连接新账号」的零粘贴入口，退化为手工粘贴指引（粘贴路径保持可用）。

#### Scenario: 已登录用户一键连接

- **WHEN** 用户在浏览器已持有 connector 会话时点「连接新账号」
- **THEN** 平台铸得一枚新 PAT 并按登录身份自动命名的账号名存储，卡片出现该账号且状态为已连接
- **AND** 用户没有被要求查看、复制任何 token，也没有被要求输入账号名

#### Scenario: 未登录时先走登录窗

- **WHEN** 用户点「连接新账号」而浏览器尚无 connector 会话
- **THEN** 平台打开 connector 的 OIDC 登录页；用户完成登录后连接流自动继续并完成存储
- **WHEN** 用户关闭登录窗而未登录
- **THEN** 连接流静默结束，不产生账号、不报错

#### Scenario: 新账号不覆盖旧账号

- **WHEN** 已有账号的用户经零粘贴流连接一个新身份的账号
- **THEN** 新账号加入列表，既有账号与其状态保持不变

#### Scenario: 同一身份重连即替换

- **WHEN** 用户对已存在的账号（同一登录身份或同名账号）再次走零粘贴流
- **THEN** 该账号的 token 与 PAT id 被替换而非新增账号，旧 PAT 被 best-effort 吊销

#### Scenario: 前提不满足时退化

- **WHEN** 部署基线无 connector 服务行，或 connector 未允许该壹座 origin 跨域铸牌
- **THEN** 卡片不呈现零粘贴入口，改为显示手工粘贴指引，粘贴路径照常工作

#### Scenario: 铸牌失败不产生半连接状态

- **WHEN** 铸牌请求被 connector 拒绝（会话失效、origin 不在允许列表等）
- **THEN** 不产生该账号的凭据行，卡片显示可重试的错误，既有账号不受影响
