## Why

萬星 connector（`https://connector.finddatatech.cloud`，open-connector-mt）已上线并提供多租户的 MCP 入口：用户用自己的统一登录（Logto）登录后，把各类 SaaS 凭据存进 connector，再铸造一个 PAT 交给 agent 使用。目前壹座用户拿不到这个能力——PAT 无处可存，dsh 会话也没有 connector MCP 入口。壹座已有 per-user MCP 凭据的成熟机制（`credentialRef`，见 `registry-credentials` 能力），把它从"只认 registry"泛化为"按 ref 名解析"，即可让 connector 复用同一条链路，无需新的存储或注入路径。

## What Changes

- **凭据存储泛化**：新增 connector 凭据的 per-user 存储（token + 更新时间），与 registry 凭据并列，沿用同一套"浏览器只写不读、状态投影返回"的契约。
- **credentialRef 多值**：`credentialRef` 从单一 `"registry"` 扩展为按名字解析（`"registry"` / `"connector"`）。安装/配置一个 connector MCP 服务时打 `credentialRef: "connector"` 标记，Authorization 头在每次 profile 写入时按 ref 解析，不落库、不随记录固化。
- **解析失败即省略**：与 registry 同形——无 live PAT 时该 MCP 服务从有效 profile 中省略并告警，记录保留；PAT 更新后下一次 profile 写入自动生效，无需重装。未知的 ref 名同样省略并告警（不透传未认证服务）。
- **用户面 API**：connector 凭据的读状态/粘贴/清除三个端点（镜像 registry 路由形：`/api/connector/connection` GET/DELETE + `/api/connector/credential` POST），键为请求身份；hosted 模式拒绝匿名写。粘贴双重校验：非 `oct_` 前缀拒收；对 connector MCP 入口探活一次，401 拒收、网络故障照存。
- **设置面板入口**：在扩展/MCP 市场附近提供一个 connector 凭据卡片：粘贴 PAT、显示已连接状态与更新时间、断开。文案说明 PAT 从哪里获取（connector 的「我的连接」页面，已上线）。
- **内置 connector MCP 服务行**：部署基线（`mcp.json`）增加一个指向 `https://connector.finddatatech.cloud/mcp` 的服务行（名 `connector`），带 `credentialRef: "connector"`；未配置 PAT 的用户看不到它，配好即出现。自托管者可用 DB 同名 disabled 行静默。
- **401 失效翻面**：泛化 dsh-events 既有 401→标记→重应用链路为按 ref 分派（并补 mcp.json 行查表盲区）：PAT 失效时会话 401 → 凭据打失效标记、卡片翻「已失效」、服务从有效 profile 省略，恰好一次重应用；重粘即恢复。
- **可见面同步**：聚焦角色"可加资源"宇宙（overlay）对带 `credentialRef` 的行（mcp.json 与 DB 一致）按凭据存活过滤，与有效 profile 语义同源。
- **`credentialRef` 收为系统管理字段**：客户端经 `/api/extensions/mcp` 提交的 config 携带 `credentialRef` 一律 400 拒收；合法打标仅市场目录安装与 operator 层 `mcp.json`。

非目标：不做 OAuth 自动换 PAT（v1 粘贴）；不做 connector 侧改动；不做 PAT 的自动轮换/过期预判/续期提醒；不改变 registry 凭据的现有注入行为（仅把解析实现纳入统一分派循环与 401 链路泛化）。

## Capabilities

### New Capabilities

- `connector-credentials`: 壹座侧 connector PAT 的 per-user 存储、状态投影、粘贴/清除 API，以及设置面板入口。

### Modified Capabilities

- `mcp-integration`: `credentialRef` 从单一 registry 值泛化为按名解析（新增 connector ref），"解析失败省略服务"对任意 ref（含未知 ref 名）一致适用。
- `extension-runtime-management`: MCP 管理 API 的准入规则收紧——客户端提交的 config 携带 `credentialRef` 一律 400 拒收（该字段由系统管理）。

（`registry-credentials` 的行为不变：registry 凭据的存储、注入与 staleness 语义原样保留，本 change 只把它的解析实现纳入"按 ref 名分派"的统一循环与 401 链路泛化——属实现细节，不产生 spec 级变更。）

## Impact

- **代码**：`registry-credentials.js`（泛化为通用 credential-ref 解析器或并列新模块）、`db.js`（新增 connector 凭据表 + 迁移）、`dsh-profile.js`（`writeMcpPatch` 的 ref 解析循环）、`dsh-events.js`（401→失效链路按 ref 泛化 + mcp.json 行查表）、`server/routes/`（新增 connector 凭据路由；`extensions.js` 安装打标与 `credentialRef` 拒收；`overlay.js` 可见宇宙过滤泛化）、`web/src/components/extensions/`（凭据卡片）、`mcp.json`（新增 connector 服务行）。
- **配置/部署**：`mcp.json` 的 connector 服务行随镜像走；无需新 Secret（PAT 是用户级数据，落 cell 的 SQLite）。
- **依赖**：依赖已上线的 connector（`https://connector.finddatatech.cloud/mcp`，PAT 为 `oct_` 前缀 Bearer）。
- **兼容性**：auth off（桌面/开发）下按 machine-owner 键控，与 registry 凭据同一退化规则；不改任何现有 API 形状。
