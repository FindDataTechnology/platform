## Context

add-crm-desk-bridge 已归档（生产 sha-449a65b）：chatwoot bundled stdio 条目 + 98-leaf 操作员面 + `crm.message.send` 动作闸（部署级共享凭据第一方例外）+ crm-desk-reception 技能（钉 account_id=1）。B 面目标：商家自带凭据（BYOK）自助订阅 pack、壹座内嵌入客服台。

探索定案的两个用户拍板：**路线 B（逐用户凭据缝，不起 HTTP 托管服务）**；**6.3 服务端代登录注入**。

探索钉死的关键事实：

1. pack manifest 的 MCP 引用只允许 `registryName`（pack-manifest.js MCP_FORBIDDEN_KEYS）；`installMcpRef`（pack-store.js:97）对非 registry 目录条目走**本地绑定**——pack-installation spec 已有「本地同名行绑定/awaiting-local-binding/allowTools 随绑定」完整条款，**安装通道零改动**。
2. 壹座连接面凭据存储按 (ref, email) 隔离（credential-refs REFS 表 + lineCredentials 模式），新 ref 即插即用；writeMcpPatch 的 envRefs 目前只解析 process.env——值源扩展是唯一真缝。
3. Chatwoot OSS v4.19 活体：profile 无 `sso_auth_token`（企业版字段）；devise `POST /auth/sign_in` 端点活着但对 §七 账号密码 401（API token 有效）——密码被轮换过，嵌入验收前置是 finddata 侧重置演示账号密码。
4. 多租户：商家=独立 Chatwoot Account+该账号 token（cw-seed-a-tenant.rb / SuperAdmin 面板，试点人工）；token 账号作用域即租户边界。

## Goals / Non-Goals

**Goals:**

- 商家路径：连接自带凭据 → 订阅 CRM 客服套件 → cell 得到自己租户的 98 面+接待技能 → 草拟/发送全程自己凭据。
- 壹座内嵌入：应用中心入口 → 反代+代登录 → 直达自家租户，无跨租户暴露。
- A 租户兼容：部署 env 共享语义保留为显式回落（机器 owner 无凭据时）。

**Non-Goals:**

- 不起 chatwoot HTTP 托管服务（路线 A 否决）；不动 Chatwoot 部署与 fd-infra。
- 不做商家自助建号自动化（B6.4 试点人工）；不做 Chatwoot 密码托管（密码只存连接面、仅代登录用）。
- 不改 mcp-chatwoot 源码；不做企微进箱等不做清单项。

## Decisions

### D1 凭据面：credentialRef `chatwoot` + 连接即物化本地行

连接中心新增 chatwoot 面板（token 必填、登录邮箱/密码选填[嵌入用]），实现走 lineCredentials 式按 (ref, email) 存储。保存时物化本地 stdio 行：config 从 bundled 条目同源拷贝（command/args 钉 dist 路径），`credentialEnv: { CHATWOOT_API_TOKEN: "chatwoot" }`、`credentialRefs: ["chatwoot"]`（嵌入读 email/password 同 ref）。清除连接=移除本地行。备选否决：让商家手填 stdio 配置（UX 灾难+token 明文进 config_json）。

### D2 env 值源扩展：`credentialEnv`（env 名 → credentialRef）

toMcpClientEntry 的解析序：`scopedEnv`/`process.env`（现 envRefs 语义，部署 env 优先级不变）之外，新增 `credentialEnv` 名单——值从 liveTokenForRef(ref, ownerEmail) 解析；无活凭据 → **条目整体省略**（与 requiresEnv 全缺省略同族，静默正常态）。部分形态（有 BASE_URL 无 token）不可发生于 credentialEnv 路径（ref 存在即整值存在）。401 失效联动：执行器/工具层 401 对 credentialEnv 路径的凭据走 invalidateRef（HTTP ref 同款）。备选否决：给 envRefs 加可选 ref 前缀语法（解析语义纠缠，两个正交声明更清楚）。

### D3 动作闸双凭据：credentialRef 优先 + 部署 env 显式回落

action-gate 既有「以用户自己的凭据执行」是主条款，A 租户共享是第一方例外——双模实现：`crm.message.send` 增 `credentialRef: "chatwoot"`。执行顺序：①该用户有活凭据 → stdio 分支子进程 env 注入用户 token；②无凭据且为机器 owner（无认证身份/自部署）→ 现行部署 env 路径；③已认证但无凭据 → preflight requireCredentialRef 拦截（connectPath 指引），不进入确认档位。判断点在 preflight（连接检查）与 executor（取值）用同一 resolve 顺序。401 语义：用户凭据路径 → invalidateRef（不误伤部署 env）；部署 env 路径 → 维持现行（报告凭据无效，无失效动作）。

### D4 pack 形状：技能变体 + 98-leaf allowTools 经本地绑定

manifest：`mcpServers: [{ registryName: "chatwoot", allowTools: [<98 名单>] }]`（离线单测对 lib/operator-tool-face.js 快照一致）；技能两份：`crm-desk-reception-merchant`（account_id 经 `profile` 发现、含 BYOK 说明与失败纪律）+ 使用说明（连接→订阅顺序两栖：先连后装=即时绑定，先装后连=awaiting-local-binding 自动激活）。发布走 facet-pack-builder 既有配方（谦面市场上架）。发布闭包校验（pack-authoring tool closure）天然要求 allowTools 覆盖技能引用的工具名——98 名单即闭包。

### D5 技能变体的 account_id 发现

商家变体首步：调 `mcp__chatwoot__profile`（98 面内有 profile 工具）取 `accounts[0].id`，后续所有调用携带之；profile 失败按四分类上报。A 租户内置变体维持钉 1（收件箱口径照旧）。

### D6 嵌入：平台反代 + 服务端 devise 代登录

新平台路由（如 `/external/desk/*`，认证门后）：①用户点应用中心卡片 → ②服务端读其 chatwoot ref 的 email/password → `POST {CHATWOOT_BASE_URL}/auth/sign_in`（devise token auth）→ 取 `access-token/client/uid/expiry` 响应头 → ③反代注入：Chatwoot SPA 会话持久化形态需一轮浏览器活体（cookies vs localStorage）后定注入法（首选：反代域上 Set-Cookie 对齐 SPA 读取的 cookie 名；备选：反代在首屏 HTML 注入一段会话引导脚本，从平台一次性短时端点取凭据头后即弃）。④后续请求按用户会话隔离转发（每用户一份上游会话头映射，进程内、不落盘）。**前置**：finddata 侧重置演示账号密码（401 事实）；密码错/上游不可达 → 可读错误页，不缓存不串话。SPA 持久化形态探测是 tasks 首项。

### D7 多租户边界与安全姿态

商家 token 账号作用域=租户边界（Chatwoot 保证）；平台侧防线：①token 不聚合（只在 owner 凭据库+其 cell patch）；②嵌入会话按用户映射、进程内不落盘；③审计/日志无凭据明文（既有断言扩展到新路径）；④嵌入路由在认证门后。越权测试用例：A 租户 token 的会话不得出现在商家嵌入/工具面，反向亦然。

## Risks / Trade-offs

- [Chatwoot devise 登录形态可能非标（SafeLine 干扰/SPA 存储）] → tasks 首项浏览器活体探明；备选注入法已列（D6③）；最坏情况 6.3 降级为 iframe+首登并在 finddata 侧对齐 spec 措辞（用户已选代登录为主目标，此为兜底不是默认）。
- [密码入连接面=比 token 重一级的凭据] → 选填字段、仅嵌入用、按用户隔离、日志零明文；spec 场景覆盖「仅 token 用户如实提示」。
- [本地行被用户手改后与 bundled 漂移] → 连接面保存即写、凭据轮换覆盖；本地绑定条款明文「不覆盖本地行」——文档写清连接面是唯一受支持入口。
- [98 allowTools 与操作员面双份维护] → 发布前单测断言 pack 名单≡operator-tool-face 快照；版本升级时同检。
- [双凭据模式的误回落] → 回落仅限机器 owner（无认证身份），已认证未连接用户一律拦截（spec 场景钉死）；单测三分支。

## Migration Plan

1. 本地：凭据面+credentialEnv+双凭据执行器（单测/突变）→ pack 内容制作与发布闭包校验 → 嵌入反代（先桩后真）。
2. 协调：finddata 侧重置演示账号密码；确认试点商家 Account 建号配方（B6.4 人工）。
3. 出片滚 platform；谦面市场上架 pack；真机验收：商家全链（连接→订阅→草拟→发送→嵌入直达）+ 越权负例 + A 租户回归（现行四链路不回归）。
4. 证据落 reports/，回 finddata 勾 6.1/6.3。

回滚：凭据面/嵌入路由为增量代码（镜像回滚即撤）；已物化本地行随连接清除；pack 下架走市场既有下架流程。
