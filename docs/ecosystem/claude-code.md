# 在 Claude Code 中使用谦面功能集

从发现到可用三步：进店 → 连接 → 安装。全程不需要壹座账号。

## 0. 前置

- Node 18+（`npx` 可用）。
- 一次性的注册处身份：Logto 注册（免费）。

## 1. 进店（两种姿态）

**插件市场形态**（推荐）：谦面就是一个原生 Claude 插件市场：

```bash
/plugin marketplace add https://facet.finddatatech.cloud/api/marketplace/marketplace.json
/plugin install <pack-id>@facet
```

装的是功能集的技能本体（版本快照）；包里有 MCP 引用的，见插件 README 的「MCP 连接指引」。

**CLI 形态**（跨 harness 通用，技能+MCP 一步到位）：

```bash
npx @finddatatechnology/facet install <packRef> --target claude-code
```

`<packRef>` = 市场详情页的功能集 id（或含 id 的 URL）。技能落 `~/.claude/skills/<skill>/SKILL.md`（用户级）或 `<dir>/.claude/skills/`（`--project <dir>` 项目级）。

## 2. 连接（MCP 需要）

功能集引用的 MCP（law-bench、fd-open-data 等）经谦面网关调用，需要一把 wgk- 调用键：

```bash
npx @finddatatechnology/facet connect
```

浏览器打开注册处 → Logto 登录 → 生成个人 wgk- 键 → 粘贴回 CLI。CLI 验活后存 `~/.facet/credentials.json`（0600）。

## 3. 安装（持键后）

```bash
npx @finddatatechnology/facet install <packRef> --target claude-code --write-mcp
```

CLI 把每个 MCP 引用写进 `~/.claude.json` 的 `mcpServers`（`type: http` + 端点 + Authorization 头），并打印所写文件清单。项目级安装写 `<dir>/.mcp.json`。

## 4. 验证

```bash
claude          # 新会话
> /mcp          # 应看到功能集引用的 server 已连接
> 调用 fd-open-data-mcp 查一下最新 CPI
```

返回真实数据（Trace 里见 `mcp__fd-open-data-mcp__*` 调用）即全链通。

## 备注

- 免费月度额度内调用免费；超额被预检挡下（402），次月自动重置。
- law-bench 属付费档：community 键调用会收到指名付费档的升级提示。
- 键可在注册处随时吊销；本地清除用 `facet connect --clear`。

## 实证记录（2026-10-12 真环境 walkthrough）

以下为本机 macOS 真跑实录（`facet v0.2.1`，公开功能集「数据-自助分析」v3，platformtest
身份经注册处控制台铸取 wgk- 键）——不是文档想象，是逐字节验证过的落位：

1. `facet connect --key wgk-…` → 验活通过，存 `~/.facet/credentials.json`（0600，
   键值只存本地）；`connect --show` 可随时查看状态。
2. `facet install <packRef> --target claude-code --write-mcp` → 技能落位
   ~/.claude/skills/<skill>/SKILL.md（用户级）；<dir>/.claude/skills/（--project）；MCP 连接配置写入 ~/.claude.json（用户级）/ <dir>/.mcp.json（--project），条目形状：
```json
"mcpServers": {
  "<server>": {
    "type": "http",
    "url": "https://mcp.finddatatech.cloud/<server>/mcp",
    "headers": { "Authorization": "Bearer wgk-…" }
  }
}
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

- Claude Code 亦支持插件市场形态（`/plugin marketplace add`，见上文）——CLI 形态与之互补，技能本体同源。

