# 在 opencode 中使用谦面功能集

从发现到可用三步：连接 → 安装 → 验证。全程不需要壹座账号。

## 0. 前置

- Node 18+（`npx` 可用）。
- 一次性的注册处身份：Logto 注册（免费）。
- opencode 1.17.3+（更早版本的 MCP 条目容器形状不同，见备注）。

## 1. 连接

```bash
npx @finddatatechnology/facet connect
```

浏览器打开注册处 → Logto 登录 → 生成个人 wgk- 键 → 粘贴回 CLI。CLI 验活后存 `~/.facet/credentials.json`（0600）。

## 2. 安装

```bash
npx @finddatatechnology/facet install <packRef> --target opencode --write-mcp
```

- 技能落 `~/.config/opencode/skills/<skill>/SKILL.md`（用户级）或 `<dir>/.config/opencode/skills/`（`--project <dir>`）。
- MCP 写 `~/.config/opencode/opencode.json` 的 **`mcp`** 键下，条目是
  `{"type":"remote","url":…,"headers":{…},"enabled":true}`，CLI 打印所写文件清单。

`<packRef>` = 谦面市场（https://facet.finddatatech.cloud）详情页的功能集 id。

## 3. 验证

新开 opencode 会话，技能可被发现、MCP server 已连接；让它查一个真实数据点（如最新 CPI），返回真实数据即全链通。

## 备注

- 免费月度额度内调用免费；超额 402，次月重置。law-bench 属付费档。
- 键随时可在注册处吊销；本地清除 `facet connect --clear`。
- **opencode 也会自动读 `~/.claude/skills` 和 `~/.agents/skills`**，所以用
  `--target claude-code` 装的技能 opencode 同样看得见；`--target opencode` 只是把
  技能写进它的原生位置。
- MCP 条目形状在版本间变过：1.x 文档写 `{mcp:{servers:{…}}}`，实测 1.17.3 用扁平
  `{mcp:{…}}`。CLI 写扁平形式；若某版本改成嵌套，条目本身仍是合法 JSON，手工迁移即可。
