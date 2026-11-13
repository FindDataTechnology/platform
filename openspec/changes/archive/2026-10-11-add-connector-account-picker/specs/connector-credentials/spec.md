# connector-credentials Delta — add-connector-account-picker

## MODIFIED Requirements

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

### Requirement: Settings panel entry for the connector credential

设置面 SHALL 提供一个 connector 凭据卡片：可粘贴 PAT、显示已连接/未连接状态与更新时间、可断开，并在未连接时说明 PAT 从何处获取（connector 的「我的连接」页面）。卡片 SHALL 在已连接与未连接两态都提供「打开连接器控制台」入口（新标签打开 connector 的 `/me` 用户面板——未连接态是指引终点，已连接态是管理入口）；入口地址 SHALL 取自部署基线中 connector 服务行的 origin + `/me`（与粘贴探活同源，不另行硬编码），基线无该行时入口隐藏、指引降级为纯文案。持有多个账号时，卡片 SHALL 以账号列表呈现：每行显示账号名、连接状态与更新时间，并标出当前活跃账号；每行 SHALL 可单独断开，非失效账号 SHALL 可切换为活跃，**失效（stale）账号行 SHALL NOT 提供「设为活跃」、只提供「重连」**（重新建立该账号，见零粘贴流）；无活跃账号时（活跃账号被删后）卡片 SHALL 提示用户显式选择一个账号。卡片 SHALL 提供「连接新账号」入口（承载零粘贴连接流，见下条需求），并 SHALL 常驻保留折叠的手工粘贴次级入口。

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

## ADDED Requirements

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
