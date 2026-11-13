# Proposal: add-facet-market-credentials

## Why

五线 AI 操作面 C1.1-B（决策出处 paas `docs/yizuo-platform-roadmap.md` AI 操作面节 +
finddata `LINES-MCP-CONFORMANCE.md`）：facet-market-mcp（市场面操作 MCP，已上线
NodePort 31893）要求以**用户市场身份**调用——但市场 app token TTL 仅 12h（MP_TOKEN_TTL_HOURS），
「粘贴终牌」不可行。壹座需持有**设备身份**（Ed25519 密钥）并经 facet 既有设备配对协议
（device-pairing-auth：bind code→pair→challenge→login）静默续登铸造短命 token，注入
facet-market MCP 服务行——与 dsh facet publish CLI（add-facet-publish-bridge D2）同构。

## What Changes

- 新模块 `facet-market-credentials.js`：按用户存设备身份（deviceId+Ed25519 密钥）+配对态
  +token 缓存；`liveToken` 同步返缓存、`ensureFresh` 异步静默续登（per-identity 串行锁——
  挑战槽单占用，并发第二 login 必 401）；401 翻面=清缓存+stale（吊销则保持 stale 提示重新配对）。
- db 迁移 v28：`user_facet_market_devices` 表（email PK）。
- `credential-refs.js` 注册第三 ref `facet-market`（轨道设计即为此预留）。
- **pack-store ref 数据驱动**：registry 来源 MCP 安装的 credentialRef 从硬编码 `registry`
  改为 `entry.metadata.credential_ref || "registry"`——服务条目自带凭据需求是注册方（线）的
  属性；facet-market-mcp 条目 PATCH `metadata.credential_ref=facet-market`。未连接对应凭据
  时安装报 credential-required（与 registry 现行同形）。
- 路由 `server/routes/facet-market.js`（镜像 connector 家族）：`GET /api/facet-market/connection`
  （状态+facetUrl 指路）、`POST /api/facet-market/pair`（6 位绑定码→keygen→pair→首铸+验证）、
  `DELETE /api/facet-market/connection`（解绑本地行+best-effort 吊销 facet 侧设备绑定）。
- 设置面板：谦面市场连接卡（绑定码输入；镜像 ConnectorConnectPanel）。
- mcp.json 基线：facet-market 服务行 `credentialRef: "facet-market"`（url=mesh 31893——
  壹座 cell 消费走 mesh 直连，与 registry MCP upstream map 同惯例）。

## Capabilities

### New Capabilities

- `facet-market-credentials`：设备身份存储与静默续登、注入语义、翻面语义、配对/解绑路由、
  凭据只写不读。

### Modified Capabilities

（无——credential-refs 的五件套契约不变，本 change 只是第三个注册者；pack 安装
spec 的 ref 选择规则变更走 `pack-installation` delta）

## Impact

- 壹座 web（面板+路由）、db（v28）、pack-store（ref 选择）、credential-refs（注册）。
- facet 侧零改动（设备配对协议既有）；facet-market-mcp 条目需一次 metadata PATCH（运维动作）。
- 后续 C2-C4 各线凭据 ref 按此模式复制（各线 token 机制不同则各论）。
