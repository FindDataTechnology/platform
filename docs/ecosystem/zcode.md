# 在 ZCode 中使用谦面功能集

从发现到可用三步：连接 → 安装 → 验证。全程不需要壹座账号。

## 0. 前置

- Node 18+（`npx` 可用）。
- 一次性的注册处身份：Logto 注册（免费）。

## 1. 连接

```bash
npx @finddatatechnology/facet connect
```

浏览器打开注册处 → Logto 登录 → 生成个人 wgk- 键 → 粘贴回 CLI。CLI 验活后存 `~/.facet/credentials.json`（0600）。

## 2. 安装

```bash
npx @finddatatechnology/facet install <packRef> --target zcode --write-mcp
```

- 技能落 `~/.zcode/skills/<skill>/SKILL.md`（用户级）或 `<dir>/.zcode/skills/`（`--project <dir>`）。
- MCP 写 `~/.zcode/cli/config.json` 的 `mcp.servers`（`type: http` + 端点 + Authorization 头），CLI 打印所写文件清单。

`<packRef>` = 谦面市场（https://facet.finddatatech.cloud）详情页的功能集 id。

## 3. 验证

新开 ZCode 会话，技能出现在技能列表；MCP server 已连接。让它查一个真实数据点（如最新 CPI），返回真实数据即全链通。

## 备注

- 免费月度额度内调用免费；超额 402，次月重置。law-bench 属付费档。
- 键随时可在注册处吊销；本地清除 `facet connect --clear`。

## 实证记录（2026-10-12 真环境 walkthrough）

以下为本机 macOS 真跑实录（`facet v0.2.1`，公开功能集「数据-自助分析」v3，platformtest
身份经注册处控制台铸取 wgk- 键）——不是文档想象，是逐字节验证过的落位：

1. `facet connect --key wgk-…` → 验活通过，存 `~/.facet/credentials.json`（0600，
   键值只存本地）；`connect --show` 可随时查看状态。
2. `facet install <packRef> --target zcode --write-mcp` → 技能落位
   ~/.zcode/skills/<skill>/SKILL.md（用户级）；MCP 连接配置写入 ~/.zcode/cli/config.json（mcp.servers 容器——与既有 stdio 条目共存），条目形状：
```json
"mcp": { "servers": {
  "<server>": {
    "type": "http",
    "url": "https://mcp.finddatatech.cloud/<server>/mcp",
    "headers": { "Authorization": "Bearer wgk-…" }
  }
} }
```
3. **wire 握手**：拿写入配置里的键与端点直接 POST `initialize`
   （`Accept: application/json, text/event-stream`）→ `HTTP 200`，返回
   `serverInfo`（如 fd-cn-report v3.4.7）并下发 `Mcp-Session-Id`——任何客户端
   加载此配置后走的正是这一握手。

**已知边界（诚实声明）**：
- 写入的 MCP 引用来自功能集清单（pack manifest 声明的 server）；实际连通还要求
  该 server 在注册处处于健康/启用状态、且你的键所属组对其可见（组不可见=401/404，
  server 停用=405）。键可见的 server 清单在 `connect` 验活时打印。
- CLI 的设备授权流（`facet connect` 免粘贴路径）要求注册处 IdP 预注册
  `facet-cli` 客户端——当前未注册（设备授权起点 400），粘贴 wgk- 键是可用路径。
- initialize 探针必须同时携带两种 Accept 类型（真客户端都会带；curl 手探注意）。

- 本机即 zcode 运行环境：写入后 `mcp.servers` 与既有 stdio 条目（如 context7）共存无冲突。

