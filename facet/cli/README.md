# @finddatatechnology/facet — 谦面 CLI

把[谦面](https://facet.finddatatech.cloud)功能集里的**技能**装进你正在用的编辑器。

```bash
npx @finddatatechnology/facet install <packRef>
```

- `<packRef>`：功能集 id（市场详情页可见），或任何含 id 的 URL。
- 默认装到 **Claude Code** 用户级技能目录（`~/.claude/skills/<skill>/SKILL.md`）。
- `--target cursor`：装到 Cursor 技能目录（`~/.cursor/skills/…`）。
- `--project <dir>`：改为项目级（`<dir>/.claude/skills/…` 或 `<dir>/.cursor/skills/…`）。
- `--base <url>`：换谦面部署地址（默认 `https://facet.finddatatech.cloud`）。
- `--registry <url>`：注册处地址，仅用于打印 MCP 端点（默认 `https://mcp.finddatatech.cloud`）。

## 它做什么、不做什么

**做**：拉取功能集最新版本的技能原文（快照），按目标编辑器的布局落盘；打印功能集声明的
MCP 引用与真实连接端点。

**不做**：
- 不写任何 MCP 配置——连接注册处的 MCP 需要 **registry 账号凭据**（per-user 令牌），
  CLI 不持有也不代持；凭据获取见输出提示。
- 不产生订阅、不做更新推送——重跑 `install` 即取新快照。
- 不安装到对话运行时——那是壹座的工作面：订阅功能集后在 壹座 → 设置 → 功能集 → 我的功能集
  一键安装（MCP 凭据在壹座内已打通）。

## 隐私

CLI 只读谦面的公开市场接口（与注册处拉取技能正文用的是同一条匿名路由），不发送任何本地数据。