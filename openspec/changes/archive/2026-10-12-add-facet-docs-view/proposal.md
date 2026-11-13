# Proposal: add-facet-docs-view

## Why

谦面市场线 F1.3（`docs/facet-market-roadmap.md`，伞文档 2026-10-12）：诉求 3「很好的文档，
使用体验很好」——谦面壳今天没有任何文档面（`#/docs` 不存在）：访客拿到一个包 id 后，
「装到我的 Claude Code / Cursor / ZCode / Codex / Gemini CLI 怎么弄」「MCP 怎么连」
「我想发布自己的包从哪开始」全靠外部文档和口口相传；按客户端安装指南、MCP 接入、
创作 quickstart 在谦面域内无处安放。

摸底发现（2026-10-12）：

- **素材已在**：五客户端深度指南已在仓内 `docs/ecosystem/*.md`（claude-code/cursor/
  zcode/codex/gemini-cli + a2a），且随 OSS 快照发布到公开仓（`docs/ecosystem/` 已在
  github.com/FindDataTechnology/platform 可见）——缺的是**谦面域内的门面与五语入口**，
  不是内容从零写起。
- **事实可单源**：CLI 的 target 表（`facet/cli/facet.js` 的 SKILLS_SUBDIR/MCP_TARGETS）
  与包名/命令（`facet/web/src/cliFacts.ts`）是装法事实的唯一真相；壳页面必须从这里取值，
  否则文档与 CLI 漂移。
- **MCP 两路均已生产在役**：wgk-key 路径（`facet connect` 铸键验活 + install 代写各客户端
  MCP 配置）是全客户端通用路径；OAuth 发现路径（注册处 401 带
  `WWW-Authenticate: ... resource_metadata=...`、RFC 9728/8414 发现文档 live、no-store）
  是客户端原生路径——**DCR（动态客户端注册）按定档推迟**（add-ecosystem-bridge 5.1），
  零贴 key 的完成度依客户端自身支持，文档必须如实写，不承诺普适零贴。
- **创作面已齐**：草稿/预设转换/manifest 直发（`#/mine`）/发布门（creators 组）/
  版本说明与不可变版本（F1.1）都在产——缺一份面向创作者的深度指南（OSS 仓 `docs/`）
  与壳内 quickstart 入口。

## What Changes

- **`#/docs` 壳内文档视图**（静态/五语/事实可验证，`check-locales.js` 强制）：
  - **按客户端安装指南**：壹座页置顶（第一公民：订阅→设置→功能集→我的功能集一键安装，
    MCP 凭据已接线，无命令行），其后五客户端各一页（Claude Code / Cursor / ZCode /
    Codex / Gemini CLI）——一条命令级：安装命令、技能落点、该客户端原生 MCP 配置文件、
    指向 OSS 仓深度指南的链接；
  - **MCP 接入**：两路并陈——通用 wgk-key 路径（注册处控制台铸键 → `facet connect`
    验活 → install 代写客户端配置）与客户端原生 OAuth 发现路径（401→resource_metadata
    →发现文档；零贴程度依客户端，DCR 未提供——如实标注）；免费额度/付费档/吊销要点；
  - **创作 quickstart**：creators 组前提、三条组装路径（壹座草稿 / 自建预设一键流 /
    `#/mine` manifest 直发）、版本说明与不可变版本、订阅 vs 安装、深度创作指南链接。
- **事实单源**：`cliFacts.ts` 扩为客户端事实表（包名/命令/五客户端技能目录/MCP 配置文件/
  默认市场与注册处地址）；`facet/cli/facet.js` 导出自身 target 表；单测断言两侧全等
  （文档不可能与 CLI 漂移）。
- **深度创作文档**：新 `docs/creating-packs.md`（创作者指南，中文），随 OSS 快照发布到
  公开仓；壳内创作块链接过去。
- **路由与哨兵**：`#/docs` 加入 hash 路由清单（公开 tab，不新增条件门）；壳哨兵 e2e 扩
   docs 三块渲染、壹座置顶、命令单源、客户端切换、深度链接、零 pageerror。

## Capabilities

### New Capabilities

（无——docs 视图是既有 shell 能力族的自然延伸，归 facet-platform）

### Modified Capabilities

- `facet-platform`: 「Shell views are addressable hash routes」路由清单增 `#/docs`
  （公开 tab；匿名可见四 tab），条件 tab 场景同步；新增 requirement
  「The facet shell carries a docs view」——三块结构、壹座置顶、五语静态、
  事实单源（单测防漂移）、深度文档落公开仓的链接纪律、MCP 两路如实呈现。

## Impact

- **代码**：`facet/web/src/DocsView.tsx`（新）、`facet/web/src/cliFacts.ts`（扩）、
  `facet/web/src/App.tsx`（路由+tab）、`facet/cli/facet.js`（导出 target 表，行为零改）、
  `web/src/locales/*/common.json`（五语 `facetDocs.*`）。
- **文档**：`docs/creating-packs.md`（新，OSS 公开面）。
- **测试**：`scripts/test-facet-docs-facts.mjs`（新：事实单源全等）、
  `e2e/facet-shell.spec.js`（扩 docs 块）。
- **部署**：常规标准线（快照→relay→GitOps→ArgoCD）；壳为镜像内 dist，无新服务、
  无新端点、无数据面变更。
- **风险**：低——纯静态视图；主要纪律是「不写会漂移的计数、命令只从 cliFacts 取」
  （家法与 intro 视图同款）。
