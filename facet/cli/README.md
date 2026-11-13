# @finddatatechnology/facet — 谦面 CLI

把[谦面](https://facet.finddatatech.cloud)智能体里的**技能**装进你正在用的编辑器，需要时一键连上包里的 **MCP**。

```bash
npx @finddatatechnology/facet install <packRef>
```

- `<packRef>`：智能体 id（市场详情页可见），或任何含 id 的 URL。
- `--target claude-code|cursor|zcode|codex|gemini-cli|workbuddy`：六家编辑器（默认 claude-code），各按其原生布局落盘（如 `~/.claude/skills/<skill>/SKILL.md`、`~/.codex/skills/…`、`~/.gemini/skills/…`、`~/.workbuddy/skills/…`）。
- `--project <dir>`：改为项目级（`<dir>/.<target>/skills/…`）。
- `--base <url>`：换谦面部署地址（默认 `https://facet.finddatatech.cloud`）。
- `--registry <url>`：注册处地址（默认 `https://mcp.finddatatech.cloud`）。
- `--oauth`：免键（OAuth）条目车道——写静态 client_id 形状而非凭据（目前仅 `workbuddy` 提供写入；两层状态见「版本说明」）；`--oauth-client <id>` 覆盖 client_id。

## 先找包（list / search）

不知道智能体 id 时不必先去网页翻——CLI 自己就能列目录，打印出来的 id 可以直接喂给 `install`：

```bash
npx @finddatatechnology/facet list                          # 列已上架智能体
npx @finddatatechnology/facet list --line lex                # 按产品线过滤（lex / wire / …）
npx @finddatatechnology/facet search 合同                     # 按关键词搜
npx @finddatatechnology/facet search 合同 --line lex --json    # 出原始行，便于脚本消费
npx @finddatatechnology/facet list --base https://facet.example.internal   # 自部署谦面
```

- `--limit <n>`：每页条数（上限 100）。
- `--json`：输出服务端原始行（字段与目录 API 一致），不做任何重排或改写。
- 目录不可达时**报出尝试过的地址与原因，不打印半截目录**；无匹配时明说「无匹配」而不是给一张空表。

## 连接 MCP（connect）

智能体引用的 MCP 经谦面注册处网关调用，需要一把 `wgk-` 调用键（免费注册即得，带月度免费额度）：

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

无键时 install 行为与旧版一致：只打印 MCP 端点与凭据要求，零写入——`workbuddy` 目标另有
`--oauth` 免键前瞻条目（服务端已就绪、5.9.3 客户端消费待版本，见下「版本说明」）。

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

**做**：拉取智能体最新版本的技能原文（快照），按目标编辑器的布局落盘；持键时代写 MCP 连接配置（打印所写文件清单）。

**不做**：
- 不产生订阅、不做更新推送——重跑 `install` 即取新快照。
- 不经确认写任何配置——MCP 写入要么 `--write-mcp` 显式开启，要么 TTY 下逐次确认。
- 键不进 shell 历史、不回显全文（`--show` 只露头尾四位）。
- 不安装到对话运行时——那是壹座的工作面：订阅智能体后在 壹座 → 设置 → 智能体 → 我的
  一键安装（MCP 凭据在壹座内已打通）。

## 更新已装的包（update）

安装会记下**装自哪个谦面**；`update` 按记录回那个地址取新版，不会把自部署的包悄悄换成官方市场上的同名包。

```bash
npx @finddatatechnology/facet update              # 全部已装包各取最新版
npx @finddatatechnology/facet update <packRef>     # 只更新一个
```

- 已是最新时打印「已最新」，不动磁盘。
- 老工具留下的记录没有 base 时回落到官方市场，**并在报告里明说**。

## 版本说明

**0.4.0** — 补上「不知道 id 也能用」和「自部署不会被带偏」两件事。

- **新增 `list` / `search`**：不必先知道 packRef 才能装。`list` 列目录，`search` 按关键词筛；
  两者都支持 `--base`（换市场）、`--line`（按产线筛）、`--limit`、`--json`（给脚本用）。

  ```bash
  npx @finddatatechnology/facet list
  npx @finddatatechnology/facet search 对账 --line wire
  ```

  目录不可达时**点名那个地址并退出非零**，不打印半截目录——半截目录比报错更坏。
  无命中时明说「无匹配」，而不是给一份空表让人以为市场是空的。

- **安装记录下 base**：`installed.json` 的每条记录多存一个 `base`，`update` 据此回**原来那个市场**
  取新版。自部署的用户不会被悄悄换成官方市场的同名包；老记录没有 base 时回落官方，
  但**在报告里明说**回落了。

```bash
npx @finddatatechnology/facet update              # 全部已装包各取最新版
npx @finddatatechnology/facet update <packRef>     # 只更新一个
```

**0.3.0** — 新增第六个安装目标 `workbuddy`（技能落 `~/.workbuddy/skills/`，MCP 落
`~/.workbuddy/mcp.json`，均经真机实证）。用法与其余目标一致：

```bash
npx @finddatatechnology/facet install <packRef> --target workbuddy --write-mcp
```

远端 MCP 条目按 `{"type": "http", "url": …, "headers": {"Authorization": …}}` 写入。
免键车道（两层状态，2026-10-30 定案）：

```bash
npx @finddatatechnology/facet install <packRef> --target workbuddy --oauth --write-mcp
```

写的是静态 OAuth 客户端条目 `{"type": "http", "url": …, "oauth": {"name", "clientId", "scope"}}`
——文件里没有任何凭据。**服务端侧已端到端实证**（静态 client_id 授权 → 网关 200 → 工具可列）；
WorkBuddy 5.9.3 的用户级 mcp.json 加载器暂不消费 `oauth` 块（客户端仅连接器/市场模板路径消费），
所以该条目是**前瞻形状**——今日真连接仍用上面的贴键命令。三层证据与机理见
`docs/ecosystem/workbuddy.md` §1a。

## 隐私

CLI 只读谦面的公开市场接口（与注册处拉取技能正文用的是同一条匿名路由），不发送任何本地数据。