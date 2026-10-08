# @finddatatechnology/facet — 谦面 CLI

把[谦面](https://facet.finddatatech.cloud)功能集里的**技能**装进你正在用的编辑器，需要时一键连上包里的 **MCP**。

```bash
npx @finddatatechnology/facet install <packRef>
```

- `<packRef>`：功能集 id（市场详情页可见），或任何含 id 的 URL。
- `--target claude-code|cursor|zcode|codex|gemini-cli`：五家编辑器（默认 claude-code），各按其原生布局落盘（如 `~/.claude/skills/<skill>/SKILL.md`、`~/.codex/skills/…`、`~/.gemini/skills/…`）。
- `--project <dir>`：改为项目级（`<dir>/.<target>/skills/…`）。
- `--base <url>`：换谦面部署地址（默认 `https://facet.finddatatech.cloud`）。
- `--registry <url>`：注册处地址（默认 `https://mcp.finddatatech.cloud`）。

## 连接 MCP（connect）

功能集引用的 MCP 经谦面注册处网关调用，需要一把 `wgk-` 调用键（免费注册即得，带月度免费额度）：

```bash
npx @finddatatechnology/facet connect            # 打开铸造页 → 粘贴 wgk- 键 → 验活后 0600 存本地
npx @finddatatechnology/facet connect --key wgk-… # 免交互
npx @finddatatechnology/facet connect --show      # 看已存状态
npx @finddatatechnology/facet connect --clear     # 清除本地键
```

注册处支持设备授权时 `connect` 自动免粘贴（RFC 8628）。持键后安装时可代写 MCP 配置：

```bash
npx @finddatatechnology/facet install <packRef> --write-mcp   # 写目标编辑器原生 MCP 配置并报告所写文件
```

无键时 install 行为与旧版一致：只打印 MCP 端点与凭据要求，零写入。

## 调用者偏好（萬星）

调用 Agent 服务的程序可以用**调用键**（sub2api 的 `sk-…`）管理自己对该服务的偏好：

```bash
npx @finddatatechnology/facet prefs <agent-slug> --key sk-…
npx @finddatatechnology/facet prefs <agent-slug> --key sk-… --set-callback https://your.host/hook <signing-secret>
npx @finddatatechnology/facet prefs <agent-slug> --key sk-… --set-reap 30
npx @finddatatechnology/facet prefs <agent-slug> --key sk-… --clear all
```

- **回合完成回调**：被叫回合结束时萬星门面向该 URL 发签名 POST（`X-Facet-Signature: t=<unix>,v1=<HMAC-SHA256("<t>.<body>")>`），尽力送达、有界重试；体带 `trace_id`，接收方可幂等去重。
- **上下文收割窗**：外部会话空闲多久被回收的分钟数；不设即随平台默认。
- `--key` 缺省读环境变量 `FACET_CALLER_KEY`；`--wanxing <url>` 换萬星门面地址。
- 密钥只入平台存储用于签名，永不回显。

## 它做什么、不做什么

**做**：拉取功能集最新版本的技能原文（快照），按目标编辑器的布局落盘；持键时代写 MCP 连接配置（打印所写文件清单）。

**不做**：
- 不产生订阅、不做更新推送——重跑 `install` 即取新快照。
- 不经确认写任何配置——MCP 写入要么 `--write-mcp` 显式开启，要么 TTY 下逐次确认。
- 键不进 shell 历史、不回显全文（`--show` 只露头尾四位）。
- 不安装到对话运行时——那是壹座的工作面：订阅功能集后在 壹座 → 设置 → 功能集 → 我的功能集
  一键安装（MCP 凭据在壹座内已打通）。

## 隐私

CLI 只读谦面的公开市场接口（与注册处拉取技能正文用的是同一条匿名路由），不发送任何本地数据。