## Why

谦面的对外交互有两个半边：给人看的门厅，和给 AI 客户端看的机器面。人那半边今天已经收敛（`unify-material-market` 归档），**机器面那半边在正门上是坏的**——不是缺功能，是返回错的东西：

- `https://agent.finddatatech.cloud/llms.txt` → **404**（`scripts/deploy-plaza.sh:31` 明明把 `generated/llms.txt` 拷贝到根，线上树里没有）。
- `https://facet.finddatatech.cloud/llms.txt` 与 `/catalog.json` → **200 `text/html`**：`facet/index.js:308` 的 SPA 兜底把任何非 `/api` 路径都返回 `index.html`。AI 客户端拿到 HTML 且**不会报错**，这是最坏的一种失败。
- plaza 快照 `counts.json` 停在 `packs:82 / 2026-11-05`，市场实际 114 个包；**代码里没有任何 cron / CI / Makefile 目标**会重新生成它，只有手工 `deploy-plaza.sh`。
- 三处机器面对同一批素材用了三套计数口径（`llms.txt` 写「577 agents / 265 skills / 22 MCP」，`catalog.json` 的 category 枚举写 `pack:82, skill:265, mcp:22, facade:22, official-data:473`），违反 plaza 自己的「一个概念一个词」纪律。
- CLI 没有 `list`/`search`：所谓「一条命令用上谦面的包」，前提是**用户已经知道 pack id**。
- 自部署者装完包再 `update`，`recordInstall` 不落 `base`，`update` 默认回 `facet.finddatatech.cloud`（`facet/cli/facet.js:1171`）——静默从官方市场拉，装成别人的版本。
- `#/docs` 里的「能力矩阵」深链指向 `docs/ecosystem/client-matrix.md`，公开仓 404，且修复表达式是一次 no-op `.replace(/client-matrix\.md$/, "client-matrix.md")`（`facet/web/src/DocsView.tsx:182`）。

这些都不是新功能，是**已经承诺过、线上一测就红**的交互。放在版本收口前修，成本最低。

## What Changes

- **机器面归位**：`agent.finddatatech.cloud` 是唯一机器面宿主，根路径 `/llms.txt`、`/llms-full.txt`、`/catalog.json`、`/robots.txt` 必须真的返回对应文件；`facet.finddatatech.cloud` 不再对机器路径返回 SPA HTML，改为诚实 404（保留人类路由的兜底不变）。
- **新鲜度可保证**：plaza 导出接入定时再生成（与发布事件无关的兜底周期），并在 `llms.txt` / `catalog.json` 首行携带 `generatedAt` 与来源计数；快照落后于线上市场超过一个周期即为可见的 stale 标记，而不是静默旧数。
- **计数口径唯一**：机器面所有计数从五物种枚举派生（`pack / skill / mcp / facade / data-anchor`，`plugin` 尚未进 plaza v2 前不出现），禁止「agents」这类合称再次出现。
- **CLI 补第一半**：新增 `facet list` 与 `facet search <query>`（读同一目录 API，支持 `--base`、`--json`、按物种/线过滤），使「不知道 id」的用户也能走到 install。
- **自部署不串市场**：`install` 把解析后的 `base` 落进 `installed.json`，`update` 缺省沿用它；`--base` 仍可覆盖；官方安装行为不变。
- **修死链并补单源**：能力矩阵链接改为仓库里真实存在的地址（或把 `client-matrix.md` 同步到公开仓），删除 no-op replace；`#/docs` 的安装命令补上自部署 `--base` 一栏。

## Capabilities

### New Capabilities

（无。所有改动都落在既有能力的需求上。）

### Modified Capabilities

- `agent-materials-plaza`: 机器面在正门路径必须可获取、必须由定时导出刷新、计数必须从物种枚举派生（改「Machine surfaces are generated from the registries' own public faces」与「Freshness is always visible and degrade is graceful」两条）。
- `facet-platform`: SPA 兜底不得覆盖机器面路径（`/llms.txt`、`/llms-full.txt`、`/catalog.json`、`/robots.txt` 与 `/api/**` 同等对待，返回 404 而非 `index.html`）；`#/docs` 深链必须指向存在的地址。
- `facet-editor-cli`: 新增目录检索子命令；`install` 记录来源 base 并被 `update` 沿用。

## Impact

- `facet/index.js`（兜底路由白名单/黑名单）
- `scripts/plaza-export.mjs`（计数口径、`generatedAt` 透出）
- `scripts/deploy-plaza.sh`（根路径产物落地与校验）
- 部署侧：plaza 再生成周期（CronJob 或既有部署流水的一步，落在 `fd-infra-deploy` / GitOps，不在本仓运行时）
- `facet/cli/facet.js`（`list` / `search` / `base` 落盘 / `update` 沿用）
- `facet/cli/README.md` 与 `facet/web/src/DocsView.tsx`、`cliFacts.ts`（自部署一栏、死链）
- e2e / 脚本：`scripts/` 下新增机器面契约断言（curl 三路径 × 两宿主）
- **不动**：市场目录 API 的形状、`marketplace.json` 的准入规则、CLI 六个 target 的落地格式、门厅的人类页面。
