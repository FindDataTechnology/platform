# 在 Gemini CLI 中使用谦面功能集

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
npx @finddatatechnology/facet install <packRef> --target gemini-cli --write-mcp
```

- 技能落 `~/.gemini/skills/<skill>/SKILL.md`（用户级）或 `<dir>/.gemini/skills/`（`--project <dir>`）。
- MCP 写 `~/.gemini/settings.json` 的 `mcpServers`（**`httpUrl`** + headers——Gemini CLI 对 streamable HTTP 用 `httpUrl` 而非 `url`），CLI 打印所写文件清单。

`<packRef>` = 谦面市场（https://facet.finddatatech.cloud）详情页的功能集 id。

## 3. 验证

新开 Gemini CLI 会话，技能可被发现、MCP server 已连接；让它查一个真实数据点（如最新 CPI），返回真实数据即全链通。

## 备注

- 免费月度额度内调用免费；超额 402，次月重置。law-bench 属付费档。
- 键随时可在注册处吊销；本地清除 `facet connect --clear`。
