# Design — add-connector-context

## Context

见 proposal.md（Why）。事实锚点（2026-10-15 实证）：

- 凭据面板 = `web/src/components/extensions/ConnectorConnectPanel.tsx`，挂载于 `McpMarketView.tsx:52`（市场页）与 `McpServerForm.tsx:364`（加服务器弹窗）；卡片已有 `meUrl`（`conn.connectorUrl + conn.mePath`，`server/routes/connector.js` 投影，`mePath="/me"`）。
- 五语言 locale 在 `web/src/locales/{en,zh-CN,ja,fr,es}/common.json`，`extensions.connector` 块各 24 叶键完全对等；`scripts/check-locales.js` 以 en 为真源，键集漂移即 fail `web:build`。
- 应用中心卡片描述来自 `agents.json` 的 `apps[]`（生产 `/api/catalog` 的 apps 数组单源 = 镜像内该文件；`AGENTS_CONFIG_URL` 远端只有 agents 数组，已实证不含 apps）。现 `wanxing-connector.description` =「数据连接器——连接企业数据库与外部数据源，铸造个人访问令牌」。
- 官网页（fd-official-web）已上线：`/zh/products/wanxing-connector/` 与 `/products/wanxing-connector/`，口径「1500+ 服务 / 万级动作 / 统一凭据」。

## Goals / Non-Goals

**Goals**：点击前给出产品上下文（卡片一句说明 + 了解产品链接）；应用中心卡片描述与实际产品对齐。
**Non-Goals**：不改弹窗行为、不改已登录 `/me`、不改 connector 侧（`add-welcome-entry` 承担）。

## Decisions

### D1 卡片说明与链接的落点与可见性

卡片标题行下方加一行说明 +「了解产品」链接：

```tsx
<p className="text-xs text-muted-foreground">
  {t("extensions.connector.contextLine")}{" "}
  <a href={learnMoreUrl} target="_blank" rel="noreferrer" data-testid="connector-learn-more">
    {t("extensions.connector.learnMore")}
  </a>
</p>
```

- 可见性：与卡片本身一致（`connectorConnection` 未知时不渲染卡片；基线无 connector 行时卡片仍渲染——说明与链接**常显**，因为它们不依赖基线 URL）。链接目标是官网公网页，与部署基线无关。
- 链接地址按界面语言选页：zh-CN / zh-TW → `https://www.finddatatech.cloud/zh/products/wanxing-connector/`；en / ja / fr / es → `https://www.finddatatech.cloud/products/wanxing-connector/`。用 i18n 的当前语言判断（`i18n.language` 前缀 `zh` 即中文页）。
- 备选否决：把说明做成 tooltip——移动端不可达且首次用户不会 hover；把链接做到「打开连接器控制台」旁边——两入口语义不同（一个去用、一个去读），挤在同排易混。

文件：`ConnectorConnectPanel.tsx`（fork 既有文件）。

### D2 locale 键

新增 `extensions.connector.contextLine`（一句产品说明，与官网页 tagline 同口径收敛）与 `extensions.connector.learnMore`（了解产品）。五语言全配，`check-locales` 门兜底。术语遵循 CONTEXT.md「连接器」词条。

### D3 agents.json 描述纠偏

`wanxing-connector.description` 改为与产品实际一致的口径（SaaS 连接网关 / 统一凭据托管 / 为 agent 铸令牌），与官网页 one-liner 基线一致。改 `agents.json`（镜像内单源）即达生产，无需改 GitOps 或 ConfigMap。无 spec delta（纯内容编辑，卡片行为不变）。

## Risks / Trade-offs

- [两处文案（官网页 vs 卡片说明）未来漂移] → 说明文案刻意收短（一句），细节只在官网页维护；CONTEXT.md 已是术语单源。
- [语言判断用 i18n 当前语言而非浏览器语言] → 与界面一致才是用户预期（用户切成 en 后界面是英文，链接指英文页正确）。
- [agents.json 描述改动需随平台镜像 roll 生效] → 正常出片线，与前端改动同趟。

## Migration Plan

常规 GHA→镜像→GitOps 线；无迁移、无 env。回滚 = revert 提交。部署排序在 open-connector-mt `add-welcome-entry` 之后（官方页链接与卡片落点与之闭环；互无硬依赖）。

## Open Questions

（无）
