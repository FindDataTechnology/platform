## Context

谦面的分发面已经有一套成熟范式：**单一分发闸 + 每市场一个投影器**。核心事实（代码级核实）：

- `facet/marketplace-json.js:36` `loadListedPacks(registry, {viewer, env})` 是**唯一**分发闸：public ∧ non-unlisted ∧ curated（`category` 非空或 `featured`），运营白名单 `FACET_MARKETPLACE_PACK_IDS` 为**替换**语义。
- 两个投影器已共用它：`facet/marketplace-json.js`（Claude `.claude-plugin/marketplace.json` 端点）与 `facet/marketplace-repo.js`（CodeBuddy/WorkBuddy `.codebuddy-plugin/` 仓，由 `scripts/export-marketplace-repo.mjs` 生成并 push）。
- MCP server 面另有独立可见性规则：`facet/mcp-catalog.js` 的 `visibleTo(entry, viewer)` = 无 required groups 即公开；`registry-bridge.js` 把 server 映射成 `{name, displayName, description, configTemplate.url, groups}`，skill 映射成 `{name, description, category, contentPath, groups, repositoryUrl, author, version, tags}`。
- 免密钥纪律已是既成事实：`facet/marketplace-repo.js` 的 `CREDENTIAL_RE` **拒绝而非清洗**（命中 `wgk-`/`sk-`/`skh_` 形状即拒写）。
- 公开仓已存在且形状可爬：`FindDataTechnology/facet-marketplace`（`.codebuddy-plugin/marketplace.json` + `plugins/<id>/skills/<n>/SKILL.md` + agents）、`fd-mcp-registry`（`.claude/skills/<n>/SKILL.md`）、`fd-vertical-packs`、`platform` 均 PUBLIC；主源码仓 `fd-craw-private` 为 PRIVATE（不可作为被第三方爬取的源）。
- 官方 MCP Registry schema 已核到 **`2025-12-11`**：必填 `name`（反向 DNS，恰好一个 `/`，pattern `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`）、`description`、`version`；`remotes[]` 为 `StreamableHttpTransport{type:"streamable-http",url}` 或 `SseTransport{type:"sse",url}`，均可选 `headers[]`（`KeyValueInput`，值可用 `{curly_braces}` 变量）。上架工具 `mcp-publisher`，认证 GitHub OAuth / GitHub OIDC / DNS / HTTP，免费。

## Goals / Non-Goals

**Goals:**

- 在现有单一闸范式上增 **一个** MCP Registry 投影器（`server.json`），复用 MCP catalog 的可见性规则，不新增第二份规则。
- 用 `mcp-publisher` + GitHub OIDC 做免费上架，CI 化、免手填凭据。
- 加固已有公开仓作为第三方技能市场（skills.sh / SkillHub）可索引源，把「登记地址」固化为运营动作与文档，而不是新代码。
- 保持免密钥纪律贯穿所有投影产出。

**Non-Goals:**

- 不做 Smithery（增值托管、偏收费）与 ChatGPT connectors（封闭审核）——不符合「免费公开」原则。
- 不做 npm / PyPI 打包分发（客群未定，先不开）。
- 不改现有六客户端 CLI 分发、Claude 端点、WorkBuddy 市场仓的任何外部行为（无 BREAKING）。
- 不在本变更实现域名验证命名 `cloud.finddatatech/*`——作为后续品牌升级路径记录（见 Decisions）。

## Decisions

### D1 — 新增投影器，不新增闸

`facet/mcp-registry-json.js` 只做**形状投影**：输入 registry server 列表（经 `registry-bridge.js` 已有映射），输出 `server.json`。可见性复用 `mcp-catalog.js` 的 `visibleTo`（无 groups 即公开），白名单沿用同一套语义。理由：`pack-marketplace` 已用「单一闸 + 多投影器」防止漂移（`wire-marketplace-json-curation` 就是一次闸不一致事故的产物）；新面若自带规则必然复现同一类事故。

**备选**：把 `server.json` 当成 `marketplace-json.js` 的一个分支输出（省一个文件）。否决：pack 与 MCP server 是两个不同的 registry 集合与可见性规则，混在一个文件里会让该文件承载两套职责，正是要避免的"第二份规则"。

### D2 — `server.json` 形状

```jsonc
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.FindDataTechnology/<server>",
  "description": "<registry description>",
  "version": "0.0.1",              // 占位：server 条目无 version 字段（见 C3）
  "title": "<displayName>",        // 可选，与 name 不同时带
  "remotes": [
    { "type": "streamable-http", "url": "https://mcp.finddatatech.cloud/<server>/mcp" }
  ]
}
```

`name` 严格按官方 pattern。`remotes` 只放 URL，**`headers` 整块省略**（见 D3/C4）。
`version`：实测 `mapServer` 产出**没有** version 字段，官方 schema 又必填 → 固定 `0.0.1` 占位并在
docs 说明「registry 侧暂无 server 版本语义」——比伪造语义化版本或挪用 pack 版本诚实。
`repository` / `websiteUrl` **省略**：server 条目无这些来源（`repositoryUrl` 只在 skill 映射上有）。
逐字段来源表见下方 C3。

### D3 — 免密钥贯穿：拒绝而非清洗

投影器复用 `marketplace-repo.js` 的 `CREDENTIAL_RE` 思路，对生成内容做一次扫描，命中即抛错、整批不写（last-good 保留）。`remotes[].headers` **整块省略**——注意 `configTemplate.headers` 里那个 `Authorization: "Bearer <your_token>"` 是占位符（不是真凭据），即使不命中 `CREDENTIAL_RE` 也不写入，因为免键端点鉴权走 OAuth discovery，静态 header 写进去只会让无凭据客户端装成坏的。理由：投影层一旦能"清洗"，上游发布闸失效就会被静默掩盖；拒写能把 bug 顶到明面上——这与 `marketplace-repo.js` 已有的姿态一致，不新造纪律。

### D4 — namespace：必须走 GitHub Actions OIDC（不是可选项）

首版用 `io.github.FindDataTechnology/*`。**已核实的硬约束**：交互式 `mcp-publisher login github`（设备流）
**无法发布到组织 namespace** —— 它走 GitHub App token，读不到组织成员关系，registry 只会授予个人
`io.github.<username>/*`（官方 Warning + registry issue #1468）。发组织名下只有两条路：

1. **GitHub Actions OIDC**（不受此限，免费，CI 原生）← 选它；
2. 带 `read:org` 的 PAT（且发布者必须是该组织 Owner）。

所以「CI 化」不是省事选项，而是发布到组织 namespace 的**唯一免费正路**；本地手工 `login github` 只能
发到个人名下，不得作为常规路径。

域名验证命名（`cloud.finddatatech/*`）需要一次性 DNS 证明（TXT 必须落在 **apex**，不是 selector；
Ed25519 需 OpenSSL 3，macOS 自带 LibreSSL 会失败，ECDSA P-384 可用；轮换须删旧 TXT）。工作量为一次性、
无持续负担，但会把 DNS 控制权变成阻塞项 → 作为后续品牌升级路径记录，不在本变更实现。

### D5 — 技能市场：靠公开仓被爬，不写适配器

skills.sh（Vercel，`npx skills add owner/repo`）与 SkillHub（`npx @skill-hub/cli install`）都按**公开 GitHub 仓的标准 `SKILL.md` / 插件目录**索引，免费。`facet-marketplace` 公开仓已具备该形状 → 本变更的"技能市场兼容"= **确认形状 + 登记地址 + 文档**，无 facet 侧新代码。理由：写逐市场适配器是重复劳动，且各市场索引机制随时变；标准形状是最稳的接口。

### D6 — 漏斗钩子放在条目说明，不放在结构里

在 registry 条目的 `description` 尾部与市场 README 的引导段加「想 7×24 常驻 → 萬星」。不改任何 manifest 结构字段（结构字段是给机器消费的，塞营销文案会污染契约）。

## Implementation Contract（apply 照此落地，勿自行发挥）

### C1 — 新增文件 `facet/mcp-registry-json.js`

```js
export const SERVER_JSON_SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
export const NAMESPACE = "io.github.FindDataTechnology";

// entry = registry-bridge 的 server 条目（见 C3）；返回 null 表示该条不可投影
export function projectServerJson(entry) {}

// 只取匿名可见（= 无 required groups）的条目；entriesFn 为注入缝，默认读 bridge
export function projectAllServers({ entriesFn }) {}

// 挂在 facet/index.js 的路由注册
export function registerMcpRegistryJson(app, { entriesFn }) {}
```

错误类型沿用既有风格（`facet/marketplace-repo.js` 的 `MarketplaceRepoError` 同款），
新增 `McpRegistryError { code: "PROJECT_REJECTED" | "SCHEMA_INVALID" }`。

### C2 — 可见性复用：**必须先把 `visibleTo` 导出**

实测：`visibleTo` 目前是 `registerFacetMcpRoutes` **内部的闭包**（`facet/mcp-catalog.js:26` 附近），
**没有导出**。投影器要复用它，只有两条合法做法：

1. 在 `facet/mcp-catalog.js` 把它提为模块级 `export function visibleTo(entry, viewer)`，
   路由内部改为引用它（行为零变化，只是位置移动）；
2. 二者都从同一个新模块（如 `facet/visibility.js`）导入。

**禁止**在新文件里重写一遍 `required.length === 0 || required.some(...)` —— 那正是
`pack-marketplace` 本次要立的单一闸纪律，重写就是自己违反自己。

投影用 `viewer = null`（匿名）。按该规则，`visibleTo(entry, null)` 当且仅当
`groups` 为空时返回 true —— 这正好等于「公开 server」，无需另写判断。

### C3 — 字段映射（逐字段来源，实测自 `registry-bridge.js:151` `mapServer`）

| `server.json` 字段 | 来源 | 缺失时 |
|---|---|---|
| `$schema` | 常量 `SERVER_JSON_SCHEMA` | — |
| `name` | `` `${NAMESPACE}/${entry.name}` `` | 无 → 该条跳过 |
| `description` | `entry.description` | 空串/缺 → **跳过该条**（schema 必填且空描述无意义） |
| `version` | **无来源** | 固定 `"0.0.1"` 占位（见下方警告） |
| `remotes[0].type` | 固定 `"streamable-http"` | — |
| `remotes[0].url` | `entry.configTemplate?.url` | 空/缺 → 跳过该条 |
| `remotes[0].headers` | **一律省略** | 见 C4 |
| `title` | `entry.displayName`（与 name 不同时） | 省略 |
| `repository` | **省略** | server 条目无 `repositoryUrl` 字段（skill 才有） |
| `websiteUrl` | 省略 | 无可靠来源 |

> **`version` 的诚实处理**：`mapServer` 产出里**没有 version 字段**（已实测，只有 skill 映射有
> `version`）。官方 schema 又必填 `version`。用 `0.0.1` 占位并在 docs 写明
> 「registry 侧暂无 server 版本语义」——**不要**伪造语义化版本，也不要为了凑字段去拿
> `packs.db` 的 pack 版本（那是 pack 的，不是 server 的）。

### C4 — 凭据门：`headers` 整个省略，不是清洗

`entry.configTemplate.headers` 实测含字面量 `{ Authorization: "Bearer <your_token>" }`——
这是**占位符不是真凭据**，`CREDENTIAL_RE` 也不会命中它。但**仍然一律不写入** `server.json`：
免键端点的鉴权走 OAuth discovery（`ecosystem-access` 既有需求），静态 header 写进去只会
在无凭据客户端上装成坏的。

`sanitize` 之外还要有**兜底拒写**：对**序列化后的整份产出**跑一次
`CREDENTIAL_RE.test()`（从 `facet/marketplace-repo.js` 导入，已 `export`），命中即抛
`PROJECT_REJECTED`、整批不写。

### C5 — 挂载点（`facet/index.js`）

import 与 `registerMarketplaceJson` / `initFacetMcpCatalog` 并列：

```js
import { registerMcpRegistryJson } from "./mcp-registry-json.js";
```

调用位置：**紧跟 `await initFacetMcpCatalog(app, { resolveUser });` 之后、静态托管之前**
（即 `file:facet/index.js` 里 `app.use(express.static(WEB_DIST…` 之前）。

`entriesFn` 复用 catalog 的取数方式（实测 `initFacetMcpCatalog` 内部就是动态 import + 读快照）：

```js
registerMcpRegistryJson(app, {
  entriesFn: () => {
    const { getMarketEntries } = requireBridge(); // 同 mcp-catalog 的动态 import 结果
    return getMarketEntries().mcpServers ?? [];
  },
});
```

路由：`GET /api/mcp-registry.json` → `{ servers: [serverJson…] }`；
再加 `GET /api/mcp-registry/{name}.json` → 单条（404 用既有的「探测不给信息」姿态，
与 `/api/mcp-catalog/:name` 一致）。两侧都 `Cache-Control: public, max-age=3600`（沿用
`marketplace-json.js` 的 `CACHE` 常量口径）。

### C6 — 测试缝

`entriesFn` 注入是唯一缝（与 `registerFacetMcpRoutes` 的 `entriesFn` 同构）。
必测四条（对应 spec 场景）：

1. 公开 server（`groups: []`）→ 产出合法文档，`name` 前缀 `io.github.FindDataTechnology/`，
   `remotes[0].url` 等于 `configTemplate.url`，且 `remotes[0].headers` **不存在**；
2. `groups: ["x"]` → 不在产出里；
3. 缺 `description` 或 `configTemplate.url` → 该条跳过、其余照出（不毒化整批）；
4. 产出里塞一个 `sk-` 形状串（构造）→ 抛 `PROJECT_REJECTED` 且不写。

第 1 条的 schema 校验用 `mcp-publisher validate` 或对 `2025-12-11` JSON Schema 本地校验。

### C7 — CI 发布脚本 `scripts/publish-mcp-registry.mjs`

```
node scripts/publish-mcp-registry.mjs --facet-url <url> [--out <dir>] [--dry-run] [--publish]
```

- 取 `GET {facet-url}/api/mcp-registry.json`，逐 server 写 `<out>/<name 去斜杠>/server.json`；
- `--dry-run` 只写不发布（CI 的 PR 校验用）；
- `--publish` 调 `mcp-publisher publish`，**认证靠 GitHub Actions OIDC**（workflow 需
  `permissions: id-token: write`）。本地 `login github` 只发个人 namespace，脚本**不得**把它当默认路径；
- last-good 契约照抄 `scripts/export-marketplace-repo.mjs`：先落暂存目录，校验全过才替换。

## Risks / Trade-offs

- **官方 Registry 仍在冻结/预览期**（API v0.1 freeze，v1 未 GA）。投影器按 `2025-12-11` schema 实现，但 schema 可能再变 → 用 schema 常量集中管理、CI 校验对 schema 校验，变更时一处改。
- **公开即不可撤回**：MCP Registry 与第三方技能市场一旦收录，下架靠 unlist/通知，用户已装副本收不回（与现有 unlist 边界同性质）。→ 在 docs 明写该边界，与 WorkBuddy 仓「下架的诚实边界」一致。
- **"技能市场兼容"验收偏运营**：skills.sh / SkillHub 无自助提交口、靠爬取，收录时间不可控 → 验收锚定"标准形状存在 + 地址已登记 + 能被 `npx ... add` 解析"，不断言"已出现在其榜单"。
- **公开仓与私有源码仓分离**：投影源必须是 PUBLIC 仓（`facet-marketplace`），不能误推私有源码内容 → 导出器自带凭据扫描 + 仓库可见性核对作为发布前门。
