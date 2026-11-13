# Design: add-facet-docs-view

## 0. 定位

F1.3 = 谦面域内自解释闭环的最后一块：匿名访客**看不懂怎么装、怎么连、怎么创作**时，
不离开谦面域就能得到答案。家法延续 intro 视图三原则：**静态**（无 live API 依赖）、
**五语**（check-locales 强制 parity）、**事实可验证**（不写计数、命令只从单源取）。

## 1. 视图结构（`#/docs`）

公开 tab，排在 intro/packs/mcp 之后（匿名可见四 tab）。视图内三块，各带锚点：

```
#/docs                 → 三块平铺（长滚动），块间锚点导航
  ├─ 安装（install）    → 壹座卡片置顶 + 五客户端 tab（一条命令级）
  ├─ MCP 接入（mcp）    → wgk-key 通用路径 + 客户端原生 OAuth 发现路径
  └─ 创作（create）     → 三条组装路径 + 发布门 + 版本纪律 + 深度指南链接
```

- **客户端切换**用视图内 tab（不新增 hash）：五客户端 + 壹座共六态，壹座**默认页**
  （第一公民纪律）。深度链接不指到具体客户端（`#/docs` 即可），保持 hash 清单最小。
- **MCP 两路**并陈而非二选一：通用路径（所有客户端可用）与原生路径（依客户端支持，
  DCR 未提供——如实标注）。文档一旦过度承诺，市场面全损（roadmap 风险 #1）。

## 2. 事实单源（防漂移的核心机制）

文档最怕「写了，然后 CLI 改了」。两道机制：

1. **命令与路径从代码取**：`cliFacts.ts` 扩为完整客户端事实表——
   `FACET_CLI_PACKAGE` / `FACET_INSTALL_COMMAND` / `FACET_CONNECT_COMMAND` /
   `FACET_TARGETS`（五客户端：label、技能目录、MCP 配置文件、目标 flag）。
   DocsView 渲染时从表取值，文案 key 只承载「话术」不承载「命令字面量」。
2. **单测全等断言**：`facet/cli/facet.js` 导出 `SKILLS_SUBDIR` / `MCP_TARGETS` /
   `targetDir`（已导出 targetDir）；新单测 `scripts/test-facet-docs-facts.mjs` 导入
   CLI 模块与 cliFacts 表，断言：目标集合全等、每客户端技能目录全等（用 FACET_HOME
   假家目录调 `targetDir` 得真路径再比对）、MCP 配置文件路径全等、命令字符串含包名
   与子命令。任何一侧改单源而另一侧忘跟，单测红。

MCP 配置文件路径的事实源是 `MCP_TARGETS[target].userFile()`（已按 `FACET_HOME` 可重定向）；
cliFacts 表存**相对家目录的展示路径**（`~/.cursor/mcp.json`），单测把 `userFile()` 的
绝对路径与假家目录拼出的展示路径互证。

## 3. MCP 两路的事实边界（文档措辞纪律）

- **wgk-key 路径**（通用）：注册处控制台（`mcp.finddatatech.cloud`）Logto 登录 →
  生成 wgk- 键 → `facet connect` 验活并存 `~/.facet/credentials.json`（0600）→
  `install --write-mcp` 代写各客户端原生配置。免费月度额度内调用免费；law-bench 等
  付费档对 community 键返回指名升级提示；吊销自助即时。
- **客户端原生 OAuth 发现路径**：注册处对未鉴权 MCP 请求回 401 +
  `WWW-Authenticate: Bearer ... resource_metadata=...`（生产实证），RFC 9728/8414
  发现文档 live（no-store）；支持 OAuth 发现的客户端可走浏览器授权。**DCR 未提供**
  （add-ecosystem-bridge 5.1 定档推迟）——「零贴 key」的程度依客户端自身对预注册/
  动态注册的支持而定，文档如实写「依客户端支持」，不承诺普适零贴。
- 文档**不写**服务器数量、工具数量、技能数量（会漂移的计数）——要指路就指
  `#/mcp` 目录页（live 面自己会说话）。

## 4. 深度文档的落点

壳内三块是**入口级**（一条命令级），深度内容落仓内 `docs/`：

- 客户端深度指南已在 `docs/ecosystem/*.md`（五客户端 + a2a），已随 OSS 快照公开——
  壳内各客户端页链接到公开仓对应文件（`github.com/FindDataTechnology/platform/blob/main/docs/ecosystem/<client>.md`）。
- 创作深度指南**新建** `docs/creating-packs.md`（中文）：从零到上架——身份前提（creators 组）、
  三条组装路径（壹座草稿 / 自建预设一键流 / `#/mine` manifest 直发）、manifest 内容模型
  要点（技能内联 / MCP 只引注册处条目 / persona-only 角色 / 可选服务契约）、发布门与
  版本不可变、版本说明（notes ≤500 字）、订阅 vs 安装、下架与可见性。随 OSS 快照发布
  （`docs/` 默认公开，无需 snapshot 脚本白名单——只有排除表，没有收录表）。
- 壳内创作块底部链到该文件的公开仓 URL。

链接的公开仓 URL 是**外部事实**（repo 名/分支），写在 cliFacts 表里单源；仓库改名时
一处改。不进单测断言（无法离线验证外部 URL 内容），但 URL 形状（github.com/
FindDataTechnology/platform/blob/main/docs/...）在 e2e 里断言 href 前缀。

## 5. i18n 结构

新增顶层命名空间 `facetDocs.*`（en 源真相，五语齐）：

```
facetDocs.title / subtitle / nav.{install,mcp,create}
facetDocs.install.{title, lead, yizuo.{title,body,steps...}, tabNote,
  client.{skillDir,mcpFile,verify}, clients.{claude-code,cursor,zcode,codex,gemini-cli}.{...}}
facetDocs.mcp.{title, lead, keyPath.{...}, oauthPath.{...}, quota.{...}}
facetDocs.create.{title, lead, path1/path2/path3, gate, versions, deepLink}
```

命令字面量（`npx @finddatatechnology/facet ...`）不进 locale 文件——组件从 cliFacts
拼接；locale 只写话术（「运行以下命令」「技能会落在」）。这与 intro 视图的
`FACET_INSTALL_COMMAND + t("...quickArg")` 同款。

## 6. 决策记录

- **D1 `#/docs` 是公开 tab 不是条件视图**：文档对匿名访客价值最大（先看懂再注册），
  且无数据面依赖。路由清单从「三公开」变「四公开」。
- **D2 客户端切换不新增 hash**：与 `#/mcp` 深度视图同款纪律（hash 清单最小化）；
  代价是不能深链到具体客户端页，可接受（文档页短）。
- **D3 壹座页置顶 + 默认选中**：第一公民纪律的文档面兑现。
- **D4 OAuth 路径如实降级**：写「依客户端支持」，不写「所有客户端零贴 key」——
  DCR 推迟的事实约束措辞。
- **D5 深度文档双层**：壳内入口级（五语）+ OSS 仓深度级（中文）——双层结构与
  roadmap D3 定档一致；深度层随 OSS 发布节奏走，不阻塞壳内层。
- **D6 单测而非 e2e 承担单源断言**：路径全等在 node 单测里可离线跑（导入 CLI 模块 +
  假 FACET_HOME），e2e 只断言渲染面（命令可见、tab 切换、链接 href 形状）。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 文档与 CLI 漂移 | cliFacts 单源 + 单测全等断言（D6） |
| 计数撒谎 | 家法：不写计数；指路 `#/mcp` live 面 |
| OAuth 过度承诺 | D4 措辞纪律：如实写依客户端支持 |
| 五语翻译质量 | check-locales 强制 parity；en 源真相、zh-CN 手写、其余三语按既有翻译风格 |
| 视图膨胀成第二官网 | 三块各一条命令级；深度内容一律外链（D5） |
