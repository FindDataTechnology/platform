## Context

- 功能集的**内容面**（技能、agents、prompt）装完即用，公开分发、零凭据；**数据面**永远要过我们的网关。
- 免键的技术前提是「客户端把 OAuth client_id 递进它的 MCP SDK」。实测证明这个前提**按客户端、按加载
  路径、按版本**分别成立（见下），而我们不能要求任何客户端配合。
- 现役六 target CLI 已有 L3（`wgk-` 设备流）与 L1 的写入形状；`facet/mcp-auth-capability` 尚不存在，
  选道靠人工记忆与文档。

**已确立的机器实证（2026-10-30/31，生产）**

| 事实 | 证据 |
|---|---|
| 静态 client_id 车道服务端全通 | 无头 PKCE：token `aud=https://mcp.finddatatech.cloud`、`roles` 7 项、`username`=邮箱；`initialize` 200；`tools/list` **161** |
| MCP 会话必须三步 | `initialize` → 取 `mcp-session-id` → `notifications/initialized` → `tools/list`（漏 session 头得 0 工具，易误判为 token 无效） |
| WorkBuddy 5.9.3 用户文件不吃 `oauth` 块 | `parseMcpServerEntry` 只留 transport/信任字段；`toAuth$2` 递 `provider:{name}` → DCR |
| WorkBuddy 5.9.3 连接器/模板路径吃 `oauth.clientId` | `toConnectorMcpItem → toAuth$1`、`toDependencyItem → toDependencyAuth` 读 `descriptor.oauth.clientId` |
| 静态 header 被所有目标采纳 | 六 target 真机写读 + 匿名 401 → 带 header 200 |
| token 无 refresh_token、scope 为空 | 授权码换回来的响应只有 `access_token/expires_in/id_token/scope/token_type`，`scope` 空 |

## Goals / Non-Goals

**Goals**

- 任何主流客户端上，用户**从不看到密钥字符串**即可连上我们的数据面。
- 客户端升级/降级后**不静默失灵**：能力表标记 stale，CLI 自动降级并明说。
- 一条通用兜底道（L2）今天就能覆盖 100% 客户端，不依赖任何上游改动。
- 「已解决」有可执行判据，不靠感觉。

**Non-Goals**

- 不要求上游客户端改代码。
- 不建伪造 DCR 的授权代理（规范已弃用 DCR）。
- 不做浏览器扩展/系统级代理来注入凭据（权限面过大、审计不可控）。
- 不替用户保管长期凭据（refresh token 留在客户端或我们的服务端，不落公共仓）。

## Decisions

### D1：三道并存 + 自动选道，而不是挑一条最优道

单道必然在某个客户端断（已实证：同一客户端两条加载路径两种结局）。三道各有不可替代的适用面：

| 道 | 适用 | 不适用 | 用户体验 |
|---|---|---|---|
| L1 原生 OAuth | 客户端消费 client_id（CC、规范客户端、连接器模板路径） | 用户文件路径不消费（WB 5.9.3） | 首次调用浏览器授权，令牌在客户端加密库 |
| L2 代持令牌 | **所有**支持静态 header 的客户端（今天=全部） | 无浏览器环境 | 一次浏览器授权，之后自动写入与续期 |
| L3 调用键 | CI/脚本/企业内分发 | 普通桌面用户（要粘密钥） | 粘一次 `wgk-`，长期有效 |

**选择权在 CLI**，不在文档。理由：文档会漂移，能力表不会（有探针与版本哨兵）。

**Alternatives**：只做 L2（拒）——令牌落配置文件，权限面宽，能避免就该避免；只做 L1（已证明会断）；
只做 L3（漏斗杀手，现状）。

### D2：L2 用「短令牌 + 静态 header」，不用 long-lived key

L2 的价值是**零客户端适配**：静态 `Authorization` header 是每个 MCP 客户端都实现的最小公约数。
风险控制靠四个约束而非靠"不写"：

1. 只写 access token（目标 8h），**不写 refresh token**；
2. 写入即 `chmod 0600` 并回读校验；
3. `facet auth --refresh` 静默续期（refresh 只打 token endpoint，无浏览器）；
4. 令牌可随时在 Logto 侧吊销，且组/角色仍在服务端判定。

**Alternatives**：把 refresh token 也写进配置（拒——长期凭据落明文不可接受）；用系统钥匙串
（好，但跨平台实现成本高，列为后续增强，不作为首版前提）。

### D3：能力表是**证据表**，字段只允许机器事实

每条记录必须带 `evidence`（探针名 + 时间戳 + 产物哈希/版本号），**禁止**写"文档说支持"。
三字段与判定方法：

| 字段 | 判定方法 |
|---|---|
| `headerStatic` | 客户端配置 schema 定位 header 字段 + 真机 401→200 往返 |
| `oauthClientId` | 解开客户端产物，定位「配置文件 → auth provider」映射函数，看是否读取该字段 |
| `dcr` | 复刻客户端注册请求打到授权服务器，看是否 4xx |

`stale` 机制：客户端版本号变化 → 该行标记 `stale` → CLI 降级 L2 + 提示「该客户端新版本待复验」。

**Alternatives**：把能力写进文档表格（拒——正是本次误判的成因）。

### D4：refresh_token 必须补齐，否则 L2 不算解决

现状 `scope` 为空且无 refresh_token。Logto 已知行为：要 `offline_access` **且** `prompt=consent`
才下发 refresh_token；native 应用还需开 rotation。补齐后 L2 才有资格声称「过期无感」。
scope 为空是**独立缺陷**（当前不致命，因为组门看 `roles`、计费看 `username`，但说明 scope 协商没生效），
必须查清而不是被"能跑"掩盖。

### D5：市场产物自带分客户端连接块

一个套件被不同宿主装上，连接方式不同。产物里放 `connect/<client>.json`（机器可用，CLI 直接合入）+
`connect/<client>.md`（人可用，一步一条命令）。这样"装完怎么连"是**产物的一部分**，不是散落的文档，
也就不会随客户端演化而腐坏。

**Alternatives**：只在 README 写一段通用说明（拒——用户仍要自己拼 JSON，正是今天的漏斗）。

## Risks / Trade-offs

- **L2 令牌落明文** → 短有效期 + 0600 + 不落 refresh + 可吊销；有 L1 就优先 L1。
- **能力表腐坏**（客户端升级后没人复验）→ 版本哨兵自动 stale + 降级提示；探针进 CI，发版前必跑。
- **refresh 补齐改身份侧行为**（`prompt=consent` 会多一次同意页）→ 只在 L2/L3 的 CLI 授权请求里带，
  L1 走客户端默认；灰度验证不打断现役 wgk-。
- **多客户端铺开的工作量** → 以"每客户端一条连接块 + 一行能力表 + 一次真机往返"为最小单位，可并行推进。
- **主 spec 与事实冲突的那条**（要求注册端点）→ 本次一并改正，避免下一个人按 spec 建 DCR 代理。

## Migration Plan

1. 能力表与探针先落（无行为变化，只产事实）→ 用今天六 target + WorkBuddy 的真实结果填表。
2. `facet auth` L2 车道落地（新子命令，不改既有 `connect`/`install` 行为）。
3. 身份侧 refresh 补齐（先预发验证，再切生产授权请求形状）。
4. 市场产物加 `connect/`，重投影发布（last-good 契约不变）。
5. 回滚：L2 是纯新增子命令；身份侧改动可按应用维度回退（`prompt=consent` 只在 CLI 请求里带）。

## Open Questions

- 系统钥匙串（macOS Keychain / Windows Credential Manager / libsecret）作为 L2 令牌存储的增强，
  是否值得首版就做？（当前判断：先文件 0600，钥匙串列为后续。）
- L2 的令牌有效期目标值：8h 是保守值；若 refresh 打通，可放宽到 24h 并靠 refresh 续。
- Claude Code 的 `--client-id`/`--callback-port` 与 L1 的兼容性需一次真机往返确认（它是最可能支持 L1 的）。
