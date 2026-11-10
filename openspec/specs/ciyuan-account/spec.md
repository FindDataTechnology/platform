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

### Requirement: Model-lane override in hosted cells

托管 cell 形态（每 cell 单一身份）下，已绑定的词元 key SHALL 覆盖该 cell 凭据存储中词元 provider 的 env ref（`LLM_PROVIDER_KEY_FINDDATA`），使**下一次**模型请求即以用户 key 计费——热加载语义与既有凭据存储要求一致，无需重启 dsh。断开或置 stale 后的凭据重写 SHALL 移除覆盖，回落 `llm-providers.json` 的部署种子 key（模型车道保持可用）。单进程多用户形态（无 per-user cell）SHALL NOT 覆盖共享凭据文件，且卡面 SHALL 如实说明该形态下账号仅用于运维工具。

#### Scenario: bound key takes effect on the next request

- **WHEN** 用户在托管 cell 内完成绑定
- **THEN** cell 凭据文件中 `LLM_PROVIDER_KEY_FINDDATA` 变为该用户的 key，且下一次模型请求用它计费，dsh 进程不重启

#### Scenario: disconnect falls back to the deployment seed

- **WHEN** 已绑定用户断开词元账号
- **THEN** 凭据重写移除覆盖，`LLM_PROVIDER_KEY_FINDDATA` 回落部署 key，模型车道继续可用

#### Scenario: single-process deployments never override

- **WHEN** 部署形态为单进程多用户（非 per-user cell）
- **THEN** 绑定不改动共享凭据文件，卡面明示模型车道仍走部署 key

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
