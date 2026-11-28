# 在 Qoder 中使用谦面功能集

从发现到可用三步：连接 → 安装 → 验证。全程不需要壹座账号。

## 0. 前置

- Node 18+（`npx` 可用）。
- 一次性的注册处身份：Logto 注册（免费）。
- 本机已装 `qodercli`（Qoder 自己的命令）。

## 1. 连接

```bash
npx @finddatatechnology/facet connect
```

浏览器打开注册处 → Logto 登录 → 生成个人 wgk- 键 → 粘贴回 CLI。CLI 验活后存 `~/.facet/credentials.json`（0600）。

## 2. 安装

```bash
npx @finddatatechnology/facet install <packRef> --target qoder --write-mcp
```

与其它 target 不同，**facet 不直接写文件**，而是驱动 Qoder 自己的命令：

- 技能：`qodercli skills install --scope user` → 落 `~/.qoder/skills/<skill>/`
- MCP：`qodercli mcp add-json facet '{"type":"http","url":…,"headers":{…}}' --scope user`

由 Qoder 自己维护配置，facet 只负责把正确的 URL 与 wgk- 头递进去。

`<packRef>` = 谦面市场（https://facet.finddatatech.cloud）详情页的功能集 id。

## 3. 验证

新开 Qoder 会话，技能可被发现、MCP server 已连接；让它查一个真实数据点（如最新 CPI），返回真实数据即全链通。

## 备注

- 免费月度额度内调用免费；超额 402，次月重置。law-bench 属付费档。
- 键随时可在注册处吊销；本地清除 `facet connect --clear`。
- **不要手改 `~/.qoder` 下的配置**：它由 qodercli 管理，手改会被下一次 CLI 变更覆盖。
- 装完要重启 Qoder 才生效（MCP 条目是本地 CLI 注册，不是被监听的文件）。
- `facet key provision --target qoder` 目前不支持：模型键写入只覆盖
  claude-code / gemini-cli / qwen / opencode。
