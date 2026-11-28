# 在 Trae 中使用谦面功能集（仅技能）

**这个 target 只装技能，不接 MCP。** Trae 没有自己的 MCP 配置面，所以 facet 不写任何
MCP 条目；想用工具面请走别的客户端（claude-code / cursor / codex / gemini-cli / qwen /
opencode / qoder / workbuddy / zcode）。

## 0. 前置

- Node 18+（`npx` 可用）。
- 一次性的注册处身份：Logto 注册（免费）。
- Trae 的 agent CLI 已装好。

## 1. 连接

```bash
npx @finddatatechnology/facet connect
```

浏览器打开注册处 → Logto 登录 → 生成个人 wgk- 键 → 粘贴回 CLI。CLI 验活后存
`~/.facet/credentials.json`（0600）。

## 2. 安装

```bash
npx @finddatatechnology/facet install <packRef> --target trae
```

- 技能落 `~/.trae/skills/<skill>/SKILL.md`（用户级）或 `<dir>/.trae/skills/`（`--project <dir>`）。
- **不要加 `--write-mcp`**：这个 target 没有 MCP 目标，加了也没有可写的位置。

`<packRef>` = 谦面市场（https://facet.finddatatech.com）详情页的功能集 id。

## 3. 让 Trae 读到你

Trae 不会自动扫描 `~/.trae/skills`——技能就是普通 markdown，需要你把 agent 的配置
指过去：

```
skills 目录：~/.trae/skills
```

指好之后新开一个 Trae 会话，技能即可被发现。

## 备注

- 免费月度额度内调用免费；超额 402，次月重置。
- 键随时可在注册处吊销；本地清除 `facet connect --clear`。
- **工具面要另找客户端**：pack 里声明的 MCP server 在 Trae 里不会出现，这是该客户端
  的形态限制，不是安装失败。
