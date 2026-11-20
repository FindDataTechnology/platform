# ciyuan-account Specification

## Purpose

词元账号：用户与萬星·词元的连接以**零粘贴**绑定——壹座用用户提供的词元登录凭据在词元侧编程铸造一把调用 key，按身份只写存储；同一把 key 既做该用户托管 cell 的模型车道凭据（覆盖部署种子、断开回落），也做 wanxing-caller 运维 MCP 引用的活 token。密码与中间 token 用后即弃，key 永不出现在任何响应与日志。

## Requirements

### Requirement: Zero-paste binding mints a per-user ciyuan key

壹座 SHALL 提供「词元账号」绑定流：用户提交词元邮箱+密码，服务端 SHALL 以服务到服务调用完成 `POST /api/v1/auth/login`（换取 access_token）→ `POST /api/v1/keys`（name 形如 `yizuo-<身份短哈希>-<日期>`，group_id 取部署配置 `CIYUAN_MINT_GROUP_ID`，默认与部署 key 同组）→ 取得**只出现一次**的明文 key 并存入该身份的凭据库。词元返回的 access_token 与用户密码 SHALL 在请求结束后即弃——不得写入任何存储、日志、trace 或响应。词元登录失败（凭据错/账号锁）SHALL 以可读原因拒绝且不改变既有状态；铸键失败但登录成功 SHALL 同样拒绝且不留半态。绑定成功后 SHALL 立即触发凭据存储重写，使下一次模型请求生效。

#### Scenario: bind mints and stores, secrets never persist

- **WHEN** 用户在词元账号卡提交正确的邮箱+密码
- **THEN** 词元侧新增名为 `yizuo-*` 的 key，壹座存储该 key（按身份），响应只含状态投影
- **AND** 服务端任何存储、日志、trace 中检索不到该密码与 access_token

#### Scenario: wrong password refuses readably

- **WHEN** 词元登录返回凭据错误
- **THEN** 卡面显示可读错误，连接状态保持原样（未连接者仍未连接）

#### Scenario: mint failure leaves no half state

- **WHEN** 登录成功但铸键请求失败
- **THEN** 绑定整体失败并给可读原因，本地不留 key、状态不变

### Requirement: Write-only per-identity storage and token-free projection

词元账号 key SHALL 按 (identity) 存储于服务端只写凭据库（与连接器家族同形态：存储层可写可删、读取仅经注入路径，任何状态/聚合 API 只返回 connected/stale/disconnected 与元数据）。投影 MAY 携带铸造时间与词元侧 key 名，MUST NOT 含 key 本体、`sk-` 片段、密码或 token 的任何形式。

#### Scenario: projection carries metadata only

- **WHEN** 任意状态或聚合端点被查询
- **THEN** 响应含状态、铸造时间、key 名，不含任何密钥材料

#### Scenario: per-identity isolation

- **WHEN** 用户 A 已绑定词元账号、用户 B 未绑定
- **THEN** B 的投影为未连接，且无 A 的任何痕迹

### Requirement: Model-lane override 按部署归属判定

模型车道的覆盖判据 SHALL 是**部署归属**（本实例属于一个客户还是多个），MUST NOT 由
宿主进程形态（是否 per-user cell）反推——同一进程形态在两种产品里含义不同：桌面版是
共享（安装方不该被覆盖），私有化交付是单租户（一客户一实例，不存在替他人计费）。

- 托管 cell 形态（每 cell 单一身份）：保持现行为——已绑定的词元 key 覆盖该 cell 凭据
  存储中词元 provider 的 env ref（`LLM_PROVIDER_KEY_FINDDATA`），下一次模型请求即以
  用户 key 计费，无需重启 dsh。
- **显式声明为单租户的部署**（`SINGLE_TENANT=1`）：SHALL 同样允许覆盖，因为该实例只有
  一个客户。归属身份解析顺序：`CELL_USER_EMAIL` → 绑定时使用的平台身份 → 部署级占位
  `owner@local`（与 `AUTH_MODE=none` 下建团队时 `ownerEmail` 的既有约定一致）。
- 未声明为单租户的单进程部署（含桌面版与多用户共享单进程）：SHALL NOT 覆盖共享凭据
  文件，且卡面 SHALL 如实说明该形态下账号仅用于运维工具。

判定缺失或无法判定时 MUST 走「不覆盖」一侧：判反的代价不对称——该生效没生效是可解释、
可修复的；不该生效却生效会让一套共享部署里的所有人悄悄替某个人计费。

#### Scenario: bound key takes effect on the next request

- **WHEN** 用户在托管 cell 内完成绑定
- **THEN** cell 凭据文件中 `LLM_PROVIDER_KEY_FINDDATA` 变为该用户的 key，且下一次模型请求用它计费，dsh 进程不重启

#### Scenario: disconnect falls back to the deployment seed

- **WHEN** 已绑定用户断开词元账号
- **THEN** 凭据重写移除覆盖，`LLM_PROVIDER_KEY_FINDDATA` 回落部署 key，模型车道继续可用

#### Scenario: single-process deployments never override

- **WHEN** 部署形态为单进程且**未**声明为单租户
- **THEN** 绑定不改动共享凭据文件，卡面明示模型车道仍走部署 key

#### Scenario: 单租户部署（机房版）允许覆盖

- **WHEN** 部署显式声明 `SINGLE_TENANT=1`（一客户一实例），客户完成词元账号绑定
- **THEN** 凭据覆盖 SHALL 生效，下一次模型请求记在客户自己的词元账号上
- **THEN** 卡面 SHALL 显示「模型车道按你的词元额度计费」，MUST NOT 显示「仅用于运维工具」

#### Scenario: 单租户下词元不可达时不静默回落

- **WHEN** 单租户部署中客户已绑定词元 key，而词元不可达或该 key 失效
- **THEN** 模型车道 SHALL 如实报「词元不可达 / 凭证失效」，对话不可用
- **THEN** MUST NOT 静默回落到部署级 key——在机房版里那等于把计费方悄悄换成我方
  （托管 cell 形态仍可按既有语义回落；两种形态的正确行为本就不同，判据随形态分叉）

#### Scenario: 共享形态仍然绝不覆盖

- **WHEN** 部署既非 cell 也未声明为单租户
- **THEN** 绑定 MUST NOT 改动共享凭据文件
- **THEN** 缺省行为落在「不覆盖」一侧，且 MUST NOT 被视为配置错误而拒绝启动

### Requirement: One key serves the wanxing-caller MCP ref

`wanxing-caller` 引用的活 token SHALL 以词元账号 key 为优先来源；身份存在历史手贴 key 且未绑定账号时，SHALL 以手贴 key 兜底（零迁移、继续生效）。401 置 stale 的既有语义 SHALL 适用于两个来源。

#### Scenario: account key preferred over legacy paste

- **WHEN** 同一身份既绑定词元账号又有历史手贴 key
- **THEN** wanxing-caller 注入使用账号 key

#### Scenario: legacy paste keeps working untouched

- **WHEN** 身份只有历史手贴 key、未绑定账号
- **THEN** wanxing-caller 注入照旧使用手贴 key，无迁移步骤

### Requirement: Test, stale, and disconnect semantics

卡面 SHALL 提供「测试连接」：以存储 key 调词元 `GET /v1/models`——200 保持/置为 connected；401 置 stale；网络失败不动状态。置 stale 时模型车道按覆盖回落要求处理（回落部署 key，平台保持可用），卡与徽章显示「需重连」；重连即重走绑定流（重铸新 key）。断开 SHALL 仅删除本地凭据并触发重写；词元侧旧 key 不吊销，卡面 SHALL 提示用户可去词元控制台自行吊销。模型调用途中的上游 401 不在本要求内自动置 stale（后续项）。粘贴 `sk-` 的次级入口 SHALL 保留在词元账号卡上（词元登录不可用时的逃生口，复用既有粘贴校验语义）。

#### Scenario: probe 401 flips stale and falls back

- **WHEN** 测试连接收到词元 401
- **THEN** 状态置 stale，模型车道回落部署 key，卡/徽章显示需重连

#### Scenario: probe network failure is a no-op

- **WHEN** 测试连接因网络错误失败
- **THEN** 状态不变

#### Scenario: disconnect is local-only with a revoke hint

- **WHEN** 用户断开词元账号
- **THEN** 本地 key 删除、状态未连接、模型车道回落部署 key
- **AND** 卡面提示词元侧 key 仍在，可在词元控制台吊销

#### Scenario: paste fallback still available

- **WHEN** 词元登录端点不可用
- **THEN** 用户仍可经卡上粘贴入口贴 `sk-` key 完成绑定（校验与既有语义一致）

### Requirement: 单租户归属必须显式声明

私有化交付（一客户一实例）SHALL 通过显式配置声明其归属，MUST NOT 由进程形态、
`AUTH_MODE`、或行业线的租户标识（如 `ERP_TENANT_ID`）推断——那些表达的是别的事情，
拿来当归属判据会让不同产品形态互相污染。

#### Scenario: 声明缺失即按共享处理

- **WHEN** 部署没有单租户声明
- **THEN** 系统 SHALL 按共享形态运行（不覆盖共享凭据文件）
- **THEN** 这 MUST NOT 被视为配置错误而拒绝启动——缺省行为是安全的那一侧

### Requirement: 粘贴 key 绑定（平台不接触密码）

客户 SHALL 能通过粘贴一把自建的词元 key 完成绑定，全程不把密码交给平台。

客户在词元控制台自行登录（用词元的 OIDC 或密码，那是词元自己的事）并创建 key，
回到平台粘贴。平台 MUST NOT 在该路径上接收、转存、记录任何密码或 OIDC 会话。

粘贴的 key SHALL 与平台代铸的 key 同等对待：同一套存储、同样可断开、同样进入凭证库。
绑定来源 SHALL 如实记录（`pasted-key` / `account` / `password`），因为三种来源对客户的
承诺不同（见「来源必须可辨」）。

形状不合（非 `sk-` 前缀、过短）的输入 SHALL 被拒绝，且响应体与日志 MUST NOT 回显原值。

#### Scenario: 粘贴后绑定生效且平台侧无密码

- **WHEN** 客户粘贴一把有效的词元 key
- **THEN** 该 key 进入凭证存储，`/api/ciyuan-account/connection` 报 `source: "pasted-key"`
- **THEN** 平台日志、数据库、凭证文件与 trace 中 MUST NOT 出现任何密码

#### Scenario: 非法形状被拒且不回显

- **WHEN** 客户粘贴一个非 `sk-` 前缀或过短的值
- **THEN** 请求被拒绝并说明形状要求
- **THEN** 响应体与日志 MUST NOT 包含该原值

### Requirement: 绑定来源必须可辨

卡面 SHALL 按绑定来源区分表述，MUST NOT 合并为一句笼统的「已绑定」——不同来源是
对客户的不同承诺。

| 来源 | 承诺 |
|---|---|
| 粘贴 key | 我们从未见过你的密码 |
| 平台代铸（密码） | 密码已在绑定后立即丢弃，未落库、未记日志 |
| OIDC 授权（若将来词元开放） | 我们在你的浏览器里完成授权，未接触密码 |

#### Scenario: 三种来源三种文案

- **WHEN** 卡面显示已绑定
- **THEN** 文案随来源不同而不同
- **THEN** MUST NOT 用「已绑定」一句盖过来源差异

### Requirement: 一键 OIDC 授权是外部依赖，不是本仓能实现的

「客户点一下授权、平台自动铸 key」需要词元侧开放第三方可兑换的授权流，或允许
`redirect_uri` 指向平台。**当前词元实现两者都不支持**（实测：`GET
/api/v1/auth/oauth/oidc/start` 的 302 中 `redirect_uri` 写死为词元自己的 callback，
`state` 由词元生成）。

平台 MUST NOT 假装支持一键授权。若将来词元侧开放，本能力可在此基础上扩展；
在那之前，绑定走「粘贴 key」与「密码」两条真实可用的路径。

#### Scenario: 不实现假的一键授权

- **WHEN** 产品面呈现绑定入口
- **THEN** 它提供的路径 MUST 是当前真的能走通的（粘贴 key / 密码）
- **THEN** MUST NOT 展示一个点了会静默失败的「一键授权」按钮
