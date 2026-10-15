# Platform

[![CI](https://github.com/FindDataTechnology/platform/actions/workflows/ci.yml/badge.svg)](https://github.com/FindDataTechnology/platform/actions/workflows/ci.yml)

> **归属寻数 [壹座 Base 线](https://www.finddatatech.cloud/zh/products/base)** · [FindData](https://www.finddatatech.cloud) 产品矩阵的执行底座——所有寻数项目都跑在这套 AI harness 上。
>
> [English](README.md) · [简体中文](README.zh-CN.md)

**Platform（v1.3.0）** 是基于 **DeepSeek Harness（dsh）** 运行时构建的本地优先 AI 助手平台：把完整的智能体执行过程——思维链、工具调用、技能执行——流式呈现到网页或 Electron 桌面端（双端界面完全一致）；基于本地索引对你自己的文档做 RAG 检索；并管理周边全家桶——模型、MCP 扩展、技能、智能体、定时任务与 bot 通道。同一套单元也可托管运行：网关为每位登录用户提供一个隔离的 **cell**，微信小程序则作为同一套契约上的瘦客户端。

## 特性一览

- **流式智能体对话** —— 思维链、工具调用、技能执行实时渲染；每场对话可自选模型与智能体。
- **自有文档 RAG** —— 导入 PDF / Markdown / 纯文本或网页 URL，回答立足于你的文档；全部数据存于本地 SQLite。
- **MCP 扩展** —— 零代码接入 MCP 服务器；扩展市场可对接自建的 [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry)。
- **智能体、功能集与定时任务** —— 支持云端刷新的智能体/应用目录、版本化功能集（pack）、带通知的 cron 定时任务。
- **Bot 通道** —— 企业微信、飞书、Telegram、微信公众号 bot，webhook 校验 + 每（bot, 会话）独立会话。
- **会话分享** —— 公开只读的 `/share/:token` 视图。
- **一个产品，多个界面** —— 网页、Electron 桌面端（macOS / Windows）、微信小程序，说同一套 WS/REST 契约。
- **本地优先，永远能启动** —— 一条命令拉起全部；可选组件缺失时优雅降级而非阻塞启动。密钥与令牌只留在服务端。

## 快速开始

```bash
npm install        # 安装后端依赖，并构建 web/dist
npm start          # http://localhost:3000（无头启动器）
npm run web:dev    # Vite 开发服务器 :5173，HMR（后端需同时在 :3000 运行）
```

`npm start` 运行无头启动器（`scripts/start.js`），由 supervisor 托管 `server.js` 这唯一一个子进程——负责加载 `.env`、健康检查、崩溃重启与日志采集。LLM 路由由 dsh 自带的 `dsh-llm` 插件（`settings.yaml` + `.credentials.yaml` 热重载）负责，SaaS 连接器由 `dsh-mcp-client` 插件负责，因此项目不打包、不部署任何额外的网关/代理服务。

> 直接 `node server.js` 也能跑起后端，但会跳过 supervisor 的配置注入与守护；日常开发请用 `npm start`。

### 打包前先构建资源

```bash
npm run predist   # 下载与当前 Node 版本匹配的独立 Node 到 resources/node/
npm run dist      # 然后才能打包安装程序
```

---

## 配置

所有敏感/环境相关配置都在 **`.env`**（已 gitignore）与 **`mcp.json`**（已 gitignore）中，模板见 `mcp.example.json`。缺失可选配置时服务优雅降级——始终能启动。

| 变量 | 作用 |
|---|---|
| `LLM_API_KEY` / `LLM_BASE_URL` | 默认 LLM 提供商（OpenAI 兼容网关）。**不内置任何 key**：未设 `LLM_API_KEY` 时服务照常启动，仅聊天不可用（记录日志），其余功能照常。`LLM_BASE_URL` 默认火山引擎 Ark coding 端点。 |
| `DEFAULT_MODEL` | 默认聊天模型（须是 `dsh-profile.js` 声明的模型 id 之一）。 |
| `ASSISTANT_NAME` | 内置智能体角色的显示名（默认 "Platform"）。 |
| `PORT` / `HOST` | 监听地址（默认 `3000` / `localhost`）。 |
| `PLATFORM_DATA_DIR` | 磁盘存储根目录（SQLite、会话等）。 |
| `RESOURCES_STORAGE_PATH` | 资源库存储目录覆盖（默认 `PLATFORM_DATA_DIR/resources-store`）。 |
| `RESOURCE_MAX_FILE_BYTES` | 单个文件资源的字节上限（默认 20MB）；比小程序下载上限更高时按客户端调整。 |
| `AUTH_MODE` | 登录模式：未设为开放访问，`forward_auth` 信任反代身份头，`logto` 使用 Logto OIDC 登录。 |
| `PAAS_BASE_URL` | Logto 回调的公开地址；未设时从请求 `Host` 推导。 |
| `SESSION_SECRET` | 会话签名密钥；未设时自动生成并持久化到 `PLATFORM_DATA_DIR/auth/session-secret`。 |
| `SESSION_TTL_HRS` | 会话 TTL（默认 24 小时），活跃会话会自动滑动续期。 |
| `LOGTO_ENDPOINT` / `LOGTO_APP_ID` / `LOGTO_APP_SECRET` | Logto OIDC 配置；Web 使用 confidential client，桌面使用 public/PKCE client。 |
| `LOGTO_CLIENT_TYPE` | `confidential`（默认）或 `public`；桌面设为 `public`。 |
| `LOGTO_END_SESSION` | 设为 `true` 时登出跳转到 Logto end-session。 |
| `DESKTOP_SERVER_PORT` | 桌面固定端口（默认 47600），用于注册 `http://127.0.0.1:47600/auth/callback`。 |
| `SSO_ENABLED` | 仅 `AUTH_MODE=none` 时生效：叠加**可选**登录入口（未登录仍可匿名使用）。登录后按规范化 SSO 邮箱记住个人模型与 MCP 可用开关，在共享 runtime 空闲时应用。**不是多租户隔离**——聊天/会话/文档/runtime 仍共享。要求反代允许匿名请求到达本服务，且本服务只能经由该反代访问（身份头否则可被伪造）。 |
| `AGENTS_CONFIG_URL` / `CATALOG_REFRESH_SECS` | Agent/应用目录云端 JSON，每 N 秒刷新（默认 60）。 |
| `NANGO_SECRET_KEY` | Nango connect session 密钥（服务端用，不发往浏览器）。 |
| `DOCUMENTS_MODEL` | Documents RAG 模型（默认 `deepseek-v4-pro`）。 |
| `MARKET_REGISTRY_URL` / `MARKET_REGISTRY_TOKEN` | 接入自建 [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry)：把 registry 里的 MCP 服务器、技能（安装时拉取内容）、Agent 拉进扩展市场与 Agent 目录。组可见性用本地 `registry-groups.json`（已 gitignore）映射；未配置 URL 时仅用内置目录。 |
| `MARKET_REGISTRY_LOGIN_PATH` / `MARKET_REGISTRY_CSRF_PATH` / `MARKET_REGISTRY_TOKENS_PATH` | registry 的登录页与个人令牌铸造端点路径（默认 `/login`、`/api/auth/csrf-token`、`/api/tokens/generate`）。自建 registry 版本升级改了路由时在这里覆盖，无需改代码。 |
| `MARKET_REGISTRY_TTL_SECS` | registry 快照刷新周期（秒，默认 300）。 |
| `BOTS_RELAY_TOKEN` | 机器调用通道（云端 MCP 等服务 → 聊天平台 bot）：`POST /api/bots/relay/send` 以 Bearer 令牌认证，只能发到管理员预先绑定的频道（`/api/bots/channels`，绑定对象必须是与 bot 聊过天的会话）。未设置时该路由返回 404（功能关闭）。令牌只应走可信网络（本机/内网，或你自己前置的 TLS 入口）。 |

想接入自建的 LLM 代理或 SaaS 连接器网关？自行部署后，按 MCP 服务器（`mcp.json`）或目录里的 `external-service` 条目接入即可——项目本身不附带这两类服务。

### Logto 登录配置

Logto 控制台需要注册两个应用，并启用 organizations / organization roles 进入 ID token：

1. Web confidential client：redirect URI 为 `https://<host>/auth/callback`，配置 `AUTH_MODE=logto`、`LOGTO_ENDPOINT`、`LOGTO_APP_ID`、`LOGTO_APP_SECRET`。
2. Desktop public client：redirect URI 为 `http://127.0.0.1:47600/auth/callback`，打包设置使用 `LOGTO_CLIENT_TYPE=public`、`DESKTOP_SERVER_PORT=47600`、`SESSION_TTL_HRS=720`。桌面安装包不包含 client secret，使用 PKCE S256。

打包后的桌面端从 `app.getPath("userData")/settings.json` 注入配置。至少提供 Logto 租户端点和 public client id；不要把 `LOGTO_APP_SECRET` 写入桌面设置：

```json
{
  "AUTH_MODE": "logto",
  "LOGTO_ENDPOINT": "https://<logto-tenant>",
  "LOGTO_APP_ID": "<desktop-public-client-id>",
  "LOGTO_CLIENT_TYPE": "public",
  "SESSION_TTL_HRS": "720",
  "DESKTOP_SERVER_PORT": "47600"
}
```

`AUTH_MODE=logto` 不支持离线首次登录：启动时必须能访问 Logto discovery/JWKS，否则后端无法完成启动；已有未过期会话在进程存活期间仍可使用，但新登录、回调和 end-session 仍需要网络。需要开放访问时，取消 `AUTH_MODE`。

组织名会映射为 group；`organization_roles` 的角色短名也会加入 group，例如 `<org>:admin` → `admin`。请在 Logto 应用的 ID token 中启用 `organizations` 和 `organization_roles`（或等价自定义 claims），并允许授权请求使用的 organizations scope。Platform 只读取这两个 claim 名称；需要管理员权限时，角色短名必须精确为 `admin`，因为目录和后台管理门禁按该名称匹配。回滚时取消 `AUTH_MODE` 即可恢复开放访问，已签发的 cookie 不再生效于认证流程。

### 托管部署（cell 运行约定）

云部署把每个用户放进一个独立的 **cell**：一个 `server.js` 进程 + 它自己的 dsh 运行时 + 它自己的数据目录。cell 之间不共享任何可变状态，隔离由进程边界保证，而不是靠应用内部的多租户逻辑；桌面版和 `npm start` 就是这个模型的单 cell 形态。

每个 cell 的环境变量矩阵（`PLATFORM_DATA_DIR`、`DSH_HOME`、`MCP_CONFIG_PATH`、`PORT`、`HOST`、`AUTH_MODE=forward_auth`、`CLOUD_MODE=1`、`CELL_GATEWAY_SECRET`）和两条硬性规则——只监听回环地址，以及 cell 数据目录必须在本地磁盘上（所有存储都是 SQLite + WAL，放在 NFS 上会损坏）——见 `.env.example` 的 "Hosted cells" 一节，那里也给出了手工启动两个 cell 的完整命令。

---

## 架构概览

- **`server.js`** — Express + WebSocket 编排器；启动 dsh 进程、翻译事件、广播给客户端。
- **`dsh-bridge.js`** — dsh 运行时桥接（stdio JSON-RPC 子进程）。
- **`dsh-profile.js`** — 写 dsh profile（`settings.yaml`、MCP patch、skills patch）。
- **`documents.js`** — 第一方文档 RAG（LlamaIndex.TS + PageIndex + SQLite）。
- **`chat-history.js`** — 只读聊天持久化（每个 turn 镜像到 SQLite）。
- **`resources.js`** — 第一方资源库：自动收录对话里生成的图表（```echarts 围栏），用户可另存工作区文件；字节放在 `resources-store/`，经 `/api/files?root=resources` 只读伺服。
- **`server/routes/external-services.js`** — 目录中 `external-service` 应用的 `/external/:appId` 反向代理。**token 留在服务端**。
- **`gateway/`** — 托管身份网关：每个登录身份对应一个 per-user cell（拉起、守护、路由）。
- **`agent-runner/`** — 把 pack 角色部署为独立的 A2A 对话智能体服务。
- **`electron/`** — 桌面 supervisor（进程管理，不跑业务逻辑）。
- **`web/`** — 网页前端（Vite + React 19 + TypeScript + Tailwind v4 + shadcn）。路由：`/chat`、`/knowledge`、`/resources`、`/agents`、`/bots`、`/trace`、`/tasks`、`/external/:appId`、公开的 `/share/:token`。
- **`miniapp/`** — 微信小程序瘦客户端（Taro 4 + React），走同一套 WS/REST 契约。
- **`packages/core`** — 共享核心（WS 消息契约、stores），`web/` 与 `miniapp/` 共用。
- **`skills/`** — 本地技能（`SKILL.md`），用 `/skill:<name>` 调用。
- **`openspec/specs/`** — 约 90 份能力规格，治理整个代码库；其中的 WS 消息契约为硬性契约。

---

## 如何添加 MCP 服务器

无需改代码，编辑 `mcp.json`（复制 `mcp.example.json` 创建）：

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "remote-http": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  }
}
```

重启 server 后自动连接，工具名格式：`mcp__<serverName>__<toolName>`。

完整的分步指南：[`docs/packaging-extensions.md`](docs/packaging-extensions.md)。

---

## 如何添加技能（Skill）

在 `skills/<name>/SKILL.md` 创建一个文件：

```markdown
---
name: my-skill
description: 一句话描述功能。
---

# My Skill

正文内容，被调用时展开执行。
```

重启后自动加载，用 `/skill:my-skill <args>` 调用。模板见 `skills/example-skill/SKILL.md`。

---

## 如何打包桌面应用

```bash
npm run predist   # 构建打包资源（独立 Node）
npm run dist      # electron-builder → .dmg (mac) / .exe (win)
npm run start:electron  # 桌面开发模式
```

输出：`dist/Platform-<version>-arm64.dmg`（mac）、`Platform Setup <version>.exe`（win x64）。

---

## 安装与发布

**CI**（`.github/workflows/release.yml`）在 3 项矩阵上构建（`macos-latest` arm64、`macos-latest` x64、`windows-latest` x64）：

- **发布：** 推 `v*` tag（如 `git tag v1.0.0 && git push --tags`）。
- **按需构建：** Actions → "Run workflow"。
- **签名：** 由 GitHub secrets 控制（无则不签名，仍成功）。

---

## DeepSeek Harness (dsh)

Platform 基于 **DeepSeek Harness (dsh)**，一个 subprocess 运行时，通过 stdio JSON-RPC 运行 dsh CLI。

- **核心变化：** 从 `@earendil-works/pi-coding-agent SDK` 迁移到 dsh。
- **session 模型：** dsh 在磁盘持久化会话；内存中不再保留消息（`buildSessionContext()` 返回空数组），所以 `chat-history.js` 必须从 SQLite 读取历史记录。
- **MCP 集成：** `dsh-mcp-client` 插件自动允许所有声明的工具，无需手动 allowlist。
- **模型切换：** dsh 在 `initialize` 握手时固化模型；切换需要重启 session (`dshBridge.restart`)。

更多细节见 [`openspec/specs/model-selection/`](openspec/specs/model-selection/) 与 [`openspec/specs/dsh-runtime-bridge/`](openspec/specs/dsh-runtime-bridge/)。

## 许可证

本项目以 [MIT](LICENSE) 许可证开源 · © 2026 FindData Technology。

---

寻数 FindData · [壹座 Base 线](https://www.finddatatech.cloud/zh/products/base) · [www.finddatatech.cloud](https://www.finddatatech.cloud)
