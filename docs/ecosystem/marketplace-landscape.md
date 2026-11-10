# 主流市场兼容：免费与公开资源调研（2026-10-31）

> 面向：谦面（facet）分发线的「公开发现」补齐。
> 关联 change：`openspec/changes/add-marketplace-projection-fanout`（本调研是其前提事实来源）。
> 已有姊妹文档：[`client-matrix.md`](client-matrix.md)（六客户端能力矩阵）、
> [`universal-keyless-mcp-auth.md`](universal-keyless-mcp-auth.md)（免键三道）、
> [`workbuddy-marketplace.md`](workbuddy-marketplace.md)（CodeBuddy 系市场仓）。

## 0. 一句话结论

真正「免费 + 公开 + 我们完全掌控」的通道只有四个：**MCP 官方 Registry**、**skills.sh**、
**SkillHub**、**Claude / CodeBuddy 原生市场**。其中三个我们已经具备内容形状（公开仓已在产），
**唯一需要写代码的是 MCP Registry 的 `server.json` 投影**。收费与封闭通道（Smithery 增值层、
ChatGPT connectors 审核制）不在本轮范围——本轮的判据就是「不花钱、不被审核卡」。

## 1. 全景判分表

```
                     收录机制              收费      我们要做的            我们现状
 ──────────────────────────────────────────────────────────────────────────────────
 MCP 官方 Registry    server.json + CLI    免费      ★ server.json 投影器    ✗ 无
  registry.model...   (mcp-publisher)               + CI 一次上架
 ──────────────────────────────────────────────────────────────────────────────────
 skills.sh (Vercel)   爬公开 GitHub 仓      免费      登记仓地址、修形状      ◐ 内容就绪
  skills.sh           npx skills add                (≈零代码)
 ──────────────────────────────────────────────────────────────────────────────────
 SkillHub             爬公开 GitHub 仓      免费层    同上                   ◐ 内容就绪
  skillhub.club       npx @skill-hub/cli            (付费只在 Skill Stacks)
 ──────────────────────────────────────────────────────────────────────────────────
 Claude plugin 市场   .claude-plugin/       免费      端点保真度核对          ✓ 已在产
  (catalog, 非托管)    marketplace.json              (轻)
 ──────────────────────────────────────────────────────────────────────────────────
 CodeBuddy/WorkBuddy  .codebuddy-plugin/     免费      无需动作(已在产)        ✓ 已在产
  (整仓 Git 源)        marketplace.json
 ──────────────────────────────────────────────────────────────────────────────────
 Smithery             URL/MCPB + 配置       增值收费  暂不碰                  — 不选
 ChatGPT connectors   官方审核               封闭      暂不碰                  — 不选
 ──────────────────────────────────────────────────────────────────────────────────
 npm / PyPI           标准包分发             免费      客群未定，不开           — 留后
```

## 2. 我们已有的公开资产（决定了工作量）

三个 **PUBLIC** GitHub 仓，形状恰好符合第三方索引器的抓取契约：

```
 FindDataTechnology/facet-marketplace   ← PUBLIC，CodeBuddy 系市场仓（在产）
   .codebuddy-plugin/marketplace.json          市场清单
   plugins/<packId>/.codebuddy-plugin/plugin.json
   plugins/<packId>/skills/<name>/SKILL.md      ← skills.sh / SkillHub 抓的就是这个
   plugins/<packId>/agents/<name>.md

 FindDataTechnology/fd-mcp-registry     ← PUBLIC
   .claude/skills/<name>/SKILL.md               ← 同上（Claude 形状）

 FindDataTechnology/fd-vertical-packs   ← PUBLIC
 FindDataTechnology/platform            ← PUBLIC
```

对照：主源码仓（同一 GitHub 组织下的私有仓，origin 同名）是 **PRIVATE**，不能被第三方爬取，
**也绝不应作为公开投影源**——公开内容一律出公开仓。

由此得出一条分界线：

```
   内容形状就绪（已付）              仍需付的
   ───────────────────            ─────────────────
   公开仓 + SKILL.md + manifest   • MCP Registry 的 server.json 投影器（唯一真代码）
   （skills.sh/SkillHub 靠爬）    • CI 上架脚本
                                  • 各市场的"登记"动作（运营，非代码）
```

## 3. MCP 官方 Registry（唯一真代码缺口）

**是什么**：`modelcontextprotocol/registry`，社区驱动的 MCP server 目录（"app store for MCP servers"），
只托管**元数据**不托管产物。**仍在 preview 期**（v0.1 API freeze，v1 未 GA），官方明示可能
breaking change 或数据重置。

### 3.1 server.json 形状（schema `2025-12-11`，已核）

远程端点型 server（我们这一类）**可以省略 `packages`，只用 `remotes`**：

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.FindDataTechnology/<server>",
  "description": "<registry description>",
  "version": "1.0.0",
  "repository": { "url": "https://github.com/FindDataTechnology/<repo>", "source": "github" },
  "remotes": [
    { "type": "streamable-http", "url": "https://mcp.finddatatech.cloud/<server>/mcp" }
  ]
}
```

必填三字段：`name` / `description` / `version`。`name` 规则：
`^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`，**恰好一个 `/`**，反向 DNS。
`remotes[]` 是 `{type:"streamable-http"|"sse", url, headers?}`，`headers` 的值可用 `{变量}` 占位
——**绝不放真凭据**（与 `facet/marketplace-repo.js` 的 `CREDENTIAL_RE` 拒写纪律同源）。

### 3.2 认证与 namespace —— 组织名有坑

| 方式 | 拿到的 namespace | 代价 |
|---|---|---|
| `mcp-publisher login github`（设备流） | **仅个人** `io.github.<你的用户名>/*` | 免费，浏览器一次 |
| GitHub Actions OIDC | **组织** `io.github.<org>/*` | 免费，CI 原生 |
| `login github --token <PAT>` | 组织（需 Owner + `read:org`） | 需造 PAT |
| `login dns` / `login http` | 自有域名 `cloud.finddatatech/*` | 一次 DNS/HTTP 证明 |

**关键坑（官方原文立场）**：交互式 `mcp-publisher login github` **当前无法发布到组织 namespace**
——设备流走 GitHub App token，读不到组织成员关系，只会授予个人 namespace。要发
`io.github.FindDataTechnology/*`，只有两条路：**GitHub Actions OIDC**（不受此限）或
**带 `read:org` 的 PAT**（且你必须是组织 Owner）。

→ 因此 CI 上架走 `GitHub Actions OIDC` 是正解，不是"省事的备选"。

### 3.3 上架流程（实测命令）

```bash
# 安装（macOS）
brew install mcp-publisher
# 或
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/

mcp-publisher init        # 生成 server.json 模板
mcp-publisher validate    # 只校验不发布 ← 接进 CI 的 dry-run
mcp-publisher login github   # 交互式（个人 namespace）
mcp-publisher publish        # 发布，输出 "Server <name> version <v>"
```

CI 版（GitHub Actions，组织 namespace 的正路）：需要 `id-token: write` 权限，走 OIDC 登录后 `publish`。

### 3.4 域名 namespace 路线（`cloud.finddatatech/*`，品牌升级）

比 GitHub OAuth 只多**一次性**证明，无持续负担。但有两个实操坑：

- **TXT 必须落在域名的 apex**（`finddatatech.cloud` 本身），不是 `_mcp-auth` 这类 selector；
  放错位置 registry 看不到，只回泛化的签名错误。
- Ed25519 路线**要求 OpenSSL 3**；macOS 自带的是 LibreSSL，会报
  `Algorithm Ed25519 not found`（需 `brew install openssl@3` 并显式调用）。**ECDSA P-384 在 LibreSSL 上可用**。
- 轮换密钥时必须**删掉旧 TXT**，残留记录会被优先尝试导致验证失败。

```bash
openssl genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
# 在 finddatatech.cloud 的 apex 加 TXT：
#   finddatatech.cloud. IN TXT "v=MCPv1; k=ed25519; p=<PUBLIC_KEY>"
mcp-publisher login dns --domain finddatatech.cloud --private-key key.pem
```

**本轮的取舍**：先发 `io.github.FindDataTechnology/*`（GitHub Actions OIDC），域名路线作为后续升级
（写在 design D4），因为它把 DNS 控制权变成了阻塞项，换不来当期的分发收益。

## 4. 技能市场（近零代码）

### 4.1 skills.sh（Vercel 出品）

- 定位："The Open Agent Skills Ecosystem"，带榜单（All Time / Trending 24h / Hot）、topic 分类、
  按 agent 过滤（CC / Cursor / Codex / Gemini …）。
- 安装：`npx skills add <owner/repo>`；条目多来自公开 GitHub 仓（`vercel-labs/skills`、`mattpocock/skills` 等）。
- **免费**：浏览/搜索/安装免费，无自助提交口（靠索引）。
- 对我们的意义：`FindDataTechnology/facet-marketplace` 已是标准 `SKILL.md` 目录形状 → 无需适配器。

### 4.2 SkillHub（skillhub.club）

- 定位：技能发现与分发平台，介于 registry 与策展市场之间，明确"内容源自 GitHub，版权归原作者"。
- 安装：`npx @skill-hub/cli install <name>`；搜索 `npx @skill-hub/cli search "<kw>"`。
- 格式：Anthropic 标准 `SKILL.md`（frontmatter + 正文），落 `~/.claude/skills/`。
- **收费边界**：核心免费；付费只在"Skill Stacks"（打包技能组合，10–50 credits 或 Pro 会员）。
  我们只上普通技能，不碰 Skill Stacks → 全程免费。
- 评级：有 AI 评估的等级（含 "S-rated"），但官方自己声明"分数不代表运行时表现或安装安全"
  ——对外宣传时**不可引用其评级当作安全背书**。

### 4.3 两者共同的诚实边界

技能市场**没有自助提交口**、靠爬取，收录时间不可控。所以验收锚点只能是：
「标准形状存在 + 地址已登记 + `npx ... add/install` 能解析到条目」，
**不能**断言"已出现在其榜单"。

## 5. 客户端原生市场（已覆盖，只做保真）

### 5.1 Claude plugin marketplace

- 形态：`.claude-plugin/marketplace.json` 的**仓**（官方原话："a catalog, not a hosted store"）。
- 用法：`/plugin marketplace add <git-url>` → `/plugin install <plugin>@<marketplace>`。
- 分层：official（Anthropic 官方仓）/ community / third-party（我们属第三层）。首次启动只自动加 official。
- 免费；组织侧可用 managed settings 做 allowlist / block / 强制安装。
- 我们的状态：JSON 端点已在产（`facet/marketplace-json.js`）。本轮只核对**条目带语义化版本、
  URL 稳定、可被 `add` 解析**——不重构。

### 5.2 CodeBuddy / WorkBuddy

- 形态：`.codebuddy-plugin/marketplace.json` 的**整仓**。
- 关键约束（已在 `workbuddy-marketplace.md` 记录）：**URL 型市场是 catalog-only**，
  只取 `marketplace.json` 与相对条目的 `plugin.json`，**不能递归镜像插件文件** → 含技能的包
  必须走 Git 整仓，否则"装上了但没内容"。
- 我们的状态：`facet-marketplace` 公开仓 + `scripts/export-marketplace-repo.mjs` 已在产，
  last-good 契约与凭据拒写都在。本轮**无需动作**。

## 6. 为什么不做 Smithery / ChatGPT connectors

| 通道 | 不收的理由 |
|---|---|
| Smithery | 定位是"托管+观测+OAuth 生成"的增值平台，收费结构偏订阅；我们的免键车道自建已完成，接入只多一层中间商。 |
| ChatGPT connectors / GPTs | 官方审核制、封闭提交，不由我们掌控节奏；且其连接器形态与我们六客户端车道重叠。 |
| npm / PyPI 打包 | 需要维护包发布流水线，客群未定；MCP Registry 的 `remotes` 路线已能覆盖"被发现"这个目的。 |

## 7. 落点（与 change 的对应）

```
 免费公开增量
 ┌───────────────────────────────────────────────────────────┐
 │ 需求 1  server.json 投影器        → facet/mcp-registry-json.js  ★代码 │
 │ 需求 2  凭据拒写贯穿投影          → 复用 CREDENTIAL_RE             代码 │
 │ 需求 3  CI 上架(GitHub OIDC)      → .github/workflows + 脚本       代码 │
 │ 需求 4  技能市场可索引            → 公开仓形状 + 登记              运营 │
 │ 需求 5  漏斗钩子(→萬星)          → 条目说明尾/README               文案 │
 └───────────────────────────────────────────────────────────┘
              │
              ▼
        发现(免费) ──> 试用(免键) ──> 想 7×24? ──> 萬星(变现)
```

## 8. 事实核对表（写文档时逐条查过）

| 结论 | 出处 |
|---|---|
| server.json 必填 name/description/version；remotes 支持 streamable-http/sse | registry 仓 `internal/validators/schemas/2025-12-11.json` |
| 远程端点型可省 packages、只写 remotes | registry `docs/modelcontextprotocol-io/quickstart.mdx` |
| 交互式 `login github` 发不了组织 namespace | registry `docs/modelcontextprotocol-io/authentication.mdx`（Warning + issue #1468） |
| 组织 namespace 走 GitHub Actions OIDC 或带 `read:org` 的 PAT | 同上 |
| DNS TXT 必须在 apex；Ed25519 需 OpenSSL 3；轮换须删旧记录 | 同上（DNS Authentication 节） |
| skills.sh 是 Vercel 出品、`npx skills add <owner/repo>` | skills.sh 首页 |
| SkillHub 免费层 + 付费只在 Skill Stacks + 评级免责 | skillhub.club 首页/FAQ |
| Claude 市场是 catalog 不是托管店、三档分层 | code.claude.com/docs/en/plugins |
| CodeBuddy URL 型市场不能镜像文件、必须整仓 | 本仓 `docs/ecosystem/workbuddy-marketplace.md` |
| 我们的公开仓清单与可见性 | `gh repo list FindDataTechnology` |
