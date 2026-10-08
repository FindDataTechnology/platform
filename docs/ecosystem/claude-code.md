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
