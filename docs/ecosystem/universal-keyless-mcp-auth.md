# 免键 MCP 鉴权：跨客户端的整体方案

> 面向：谦面/萬星 的功能集要装进**任何**主流编辑器与市场（Claude Code、Cursor、ZCode、Codex CLI、
> Gemini CLI、WorkBuddy/CodeBuddy、VS Code、Windsurf、Cline、Continue、Zed、JetBrains、
> Claude Desktop、ChatGPT 连接器……），用户**不该被要求粘贴任何密钥**。
>
> 本文是设计定案（2026-10-31），实施已于同日归档：spec 见
> `openspec/specs/mcp-auth-lanes`、`openspec/specs/ecosystem-access`、`openspec/specs/facet-editor-cli`。

## 0. 为什么不能只做一条道

免键的**技术前提**是「客户端把 OAuth 客户端标识（client_id）交给它的 MCP SDK」。这个前提在不同客户端
的不同版本里成立程度不同，而我们**无法要求人家改**（WorkBuddy 官方话说得很清楚：不对接）。

实测过的三种现实（2026-10-30/31，生产端点）：

| 现实 | 证据 |
|---|---|
| 服务端车道**完全可用** | 静态 client_id + PKCE 全链：token `aud` 命中、`initialize` 200、`tools/list` **161 工具** |
| WorkBuddy 5.9.3 **用户文件**不消费 `oauth` 块 | 出厂 asar 代码级：`parseMcpServerEntry` 丢弃该块；`UserMcpProvider → toAuth$2` 只递 `provider:{name}` → 回落到动态注册（DCR）→ 我们无 DCR → `Incompatible auth server` |
| WorkBuddy 5.9.3 **连接器/市场模板**路径**消费** `oauth.clientId` | 同 asar：`toConnectorMcpItem → toAuth$1`、`toDependencyItem → toDependencyAuth` 都读 `descriptor.oauth.{clientId,scope,…}`；官方 Outlook 连接器即此形状 |

**结论**：单条道必然在某个客户端上断。方案必须是**分道 + 自动选道 + 一条永远可用的兜底道**。

## 1. 三道设计

```
                    ┌─────────────────────────────────────────────┐
                    │  能力表（每客户端每版本 · 机器实证 · 非推断）  │
                    └──────────────────┬──────────────────────────┘
                                       │ CLI 按表选道
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
   L1 原生 OAuth                  L2 代持令牌                    L3 调用键
  (客户端自己走授权)            (CLI 走授权、写 bearer)         (设备流 wgk-)
  零凭据落盘                     零用户可见密钥                   headless/CI
  前提：客户端消费 client_id     前提：客户端支持静态 headers     前提：能跑 CLI
```

### L1 原生 OAuth（最干净，但要看客户端脸色）

配置里只写**静态客户端标识**，不含任何秘密：

```json
{ "type": "http", "url": "https://mcp.finddatatech.cloud/<server>/mcp",
  "oauth": { "name": "facet", "clientId": "tvmzkpz3ld5kqlmse5se9",
             "scope": "openid gateway:access offline_access" } }
```

用户首次调用时浏览器授权一次，令牌存客户端自己的加密库。**我们服务端已就绪**（静态 client_id 短路
DCR、origin 注册为 API 资源、custom-JWT 注入 roles/username、网关接受自广告 audience）。
**道是否通只取决于客户端是否把这个字段递进它的 SDK** —— 这就是能力表要回答的唯一问题。

### L2 代持令牌（**今天就能覆盖 100% 客户端**的兜底）

思路：**客户端不会做 OAuth，那就不让它做**。CLI 自己做标准 PKCE 授权，把拿到的 access token
以 `Authorization: Bearer …` 写进目标客户端的静态 headers —— 而**静态 headers 是每个客户端都支持的**：

```json
{ "type": "http", "url": "https://mcp.finddatatech.cloud/<server>/mcp",
  "headers": { "Authorization": "Bearer <access_token>" } }
```

```bash
facet auth --target workbuddy --write-mcp     # 弹一次浏览器授权，之后自动写入
facet auth --status                            # 看令牌余期与可刷新性
facet auth --refresh                           # 静默续期并原地改写配置
```

对用户而言**仍然是免键**（他要做的只有「点授权」，和 L1 的体验一致），对我们的收益是**不再赌任何客户端的
配置解析实现**。代价：令牌落在配置文件里（明文）——用三重手段把风险压到与调用键同级以下：

1. **短有效期**（目标 8h；access token 天然短），配置里不出现 refresh token；
2. 文件权限 0600 + 写入即校验；
3. 过期后 `facet auth --refresh` 一条命令或按 401 提示重跑；令牌可随时在 Logto 侧吊销。

> 为什么比 L3 好：用户不再需要「去铸造页拿一串 wgk- 再粘回来」。为什么不能只有 L2：CI/无浏览器
> 环境仍要 L3；且 L2 的令牌是**用户身份代理物**，权限面比 scoped 调用键更宽，能做 L1 的客户端优先 L1。

### L3 调用键（保留，headless/CI 与降级）

现役 `wgk-` 设备流（`facet connect`）：无浏览器可跑、可长期存放、可吊销、按组授权。
保留为：CI/脚本、L1/L2 都不可用的极端环境、以及企业内分发。

## 2. 三个必须补的工程件

### 2.1 能力表 + 自动探针（**方案的地基**）

`facet/mcp-auth-capability.js` 维护一张**证据表**，每行 = 客户端 × 版本区间 × 三个问题：

| 字段 | 含义 | 怎么来的（**禁止推断**） |
|---|---|---|
| `headerStatic` | 配置里写死 `Authorization` 是否被采纳 | 客户端配置 schema（代码/文档）+ 真机 401→200 |
| `oauthClientId` | 配置里的 `oauth.clientId` 是否进 SDK provider | **读客户端出厂代码**（asar/二进制/包内 JS）定位配置解析器与 auth 映射函数 |
| `dcr` | 是否支持动态注册 | 授权服务器元数据探测 + 客户端请求形状复刻 |

`scripts/probe-mcp-auth-lanes.mjs` 做三件事，全部产出机器可读 JSON（写回能力表）：

1. **静态探针**：解开客户端产物，定位「配置文件 → auth provider」的映射函数，判定 `oauth.clientId`
   是否被读取（WorkBuddy 就是这么定的案）。
2. **协议探针**：用**该客户端的请求形状**（resource 值、scope、回调路径、PKCE 方法）无头复刻一遍，
   断言 `initialize` 200 且 `tools/list` 非空——这是服务端是否买账的唯一判据。
3. **版本哨兵**：客户端版本变化 → 能力表标记 `stale`，CLI 自动降级到 L2 并打印升级提示，**不静默失败**。

### 2.2 refresh_token 与续期（L2 的生命线）

早前实测只拿到「`scope` 为空、没有 refresh_token」，结论是 L2 会退化成「每 8h 人工重授权」。
**该结论已被真机推翻**，现在是通的，但只有照下面两条做才通：

- **授权时必须带 `offline_access` 且 `prompt=consent`**。只带 `offline_access` 不够——Logto 只在
  强制 consent 时才发 refresh_token。这是唯一能验证这一点的地方：桩测试永远看不出「没给 refresh_token」。
- **续期时只重放 `resource`，绝不可重放 `scope`**（生产实测两条硬约束）：
  - 不带 `resource` → 回**客户端绑定的 opaque token**（无 `aud`），网关不认：形如「续期成功却连不上」；
  - 带任意 `scope` → `400 oidc.invalid_scope / refresh token missing requested scope`。
    `gateway:access` 是**授权时刻授予的 resource scope**，不在 refresh token 可刷新集合里。

真机终验：`AUTHED {"min":60,"renewable":true}` → `REFRESH: OK {"min":60,"rotated":true,
"user":"…","aud":"https://mcp.finddatatech.cloud"}`——refresh token 轮换、身份与受众回位、用户零操作。
故 L2 的令牌**可静默续期**（refresh 只打 token endpoint，无浏览器）。

仍待查（不影响鉴权，但是协商缺陷）：授权响应里的 `scope` 字段为空。组门看 `roles`、计费看
`username`，所以鉴权不受影响——正因为不受影响才更容易漏掉，**必须单独查清**。

### 2.3 市场渠道 × 每个宿主客户端的连接块

同一个功能集，装进不同客户端需要**不同的连接块**。市场产物必须自带：

```
plugins/<pack>/
  .codebuddy-plugin/plugin.json     # 套件清单（skills 声明）
  README.md                          # 人读：这个套件要连什么、怎么连
  connect/
    <client>.json                    # 机器读：该客户端的连接块（可直接抄/由 CLI 合入）
    <client>.md                      # 人读：一步一条命令
```

覆盖渠道与客户端：

| 渠道 | 宿主客户端 | 连接块形态 | 默认道 |
|---|---|---|---|
| Claude 插件市场（JSON 端点 + `/plugin marketplace add`） | Claude Code | `.mcp.json` / `--mcp-config` | L1（CC 支持 `--client-id`）→ L2 |
| Git 市场仓（`.codebuddy-plugin/marketplace.json`） | WorkBuddy 5.9.3 | 连接器/模板条目 / 用户 `mcp.json` | **L2**（用户文件不吃 oauth）/ L1（若走连接器模板） |
| 同上 | CodeBuddy | 同上 | 探针定 |
| npm CLI（`npx @finddatatechnology/facet`） | 六 target 全覆盖 | 由 CLI 写 | 按表选道 |
| 官网/文档粘配置 | VS Code / Windsurf / Cline / Continue / Zed / JetBrains / Claude Desktop | `mcp.json`-类 JSON | L2 兜底，L1 有则用 |

## 3. 用户实际会看到什么

**装一个套件（以 WorkBuddy 为例，当前版本）**

```bash
# 1) 从市场装（零凭据）
#    客户端：技能页 → 技能市场 → 套件 → 「+ 添加市场」→ FindDataTechnology/facet-marketplace
# 2) 连数据（一次浏览器授权，之后自动续）
npx @finddatatechnology/facet auth --target workbuddy --write-mcp
#    → 浏览器打开我们的授权页，登录同意
#    → 自动写 ~/.workbuddy/mcp.json（Bearer 短令牌，0600）
#    → 打印：令牌 8h 后过期，长期不用请 `facet auth --refresh`
```

**没有任何一步要求用户打开注册处、复制一串 `wgk-` 密钥。**

## 4. 判据（怎么算"彻底解决"）

一个客户端算「已解决」，必须同时满足：

1. 装包零凭据（市场产物里凭据形状扫描零命中）；
2. 连数据**用户不需要看到任何密钥字符串**（无论哪条道）；
3. 令牌过期后**不需要用户重新做一次完整授权**（L1 由客户端刷新；L2/L3 由 `facet auth --refresh`
   静默续期）；
4. 失败可诊断：401 时给出「令牌过期 / 组不匹配 / 服务停用」三分类，而不是一句 401；
5. 能力表对该客户端版本有**机器实证记录**（不是文档推断）。

第 3 条今天已通（真机 refresh 轮换实证，见 §2.2）；第 5 条是避免"再误判一次"的制度保障。

### 4.1 上线检查单（每个客户端逐条签，缺一条就不许说"已解决"）

| # | 判据 | 怎么验（命令） | 期望 |
|---|---|---|---|
| 1 | 产物零凭据 | 对市场仓跑生成器正则 `CREDENTIAL_RE` | 0 命中 |
| 2 | 用户看不到密钥 | `facet auth --target <c> --write-mcp` 全程 | 只有浏览器授权，输出无密钥串 |
| 3 | 过期不重授权 | `facet auth --refresh` | 一次成功、token 轮换、aud 正确 |
| 4 | 401 可分类 | 过期/组不符/停用三种响应体 | 分别给出「过期 / 组不匹配 / 服务停用」文案 |
| 5 | 有机器证据 | `probe-mcp-auth-lanes.mjs static --app <产物>` + `protocol --url … --token …` | 静态判定与 asar 一致，`tools/list` 非空 |

签名格式：`<client> <版本> 1✅ 2✅ 3✅ 4✅ 5✅ (证据: 探针输出 / 台账 §)`。

### 4.2 一个已知未达标的点（诚实记账）

**旧 refresh token 在轮换后仍然有效**（2026-10-31 真机：连刷两次各得新 RT，但用最初的
`rt0` 再打 token 端点仍 200）。这**不影响用户**（续期照常），但意味着 **refresh token 被盗
无法靠轮换自动止损**——租户侧没开 reuse detection / RT 失效。要补的是 Logto 应用配置，
不是本仓库代码；在此之前凭据泄露的止损手段只有服务端吊销。这一条**不阻塞**判据 1-5，
但必须记着：对外文案不能承诺"令牌轮换即自动失效"。

## 5. 与既有工作的关系

- 已上产：静态 client_id 车道（服务端）、六 target CLI、Git 市场仓、npm 0.3.0、Claude 市场 JSON 端点。
- 本方案**新增**：L2 代持令牌道（已落地）、能力表与自动探针、refresh 续期约束、市场产物的 `connect/` 分客户端连接块。
- 明确的非目标：不要求任何客户端改代码；不引入自建授权代理去伪造 DCR（DCR 已被规范弃用，
  为它建代理是把技术债固化成架构债）。
