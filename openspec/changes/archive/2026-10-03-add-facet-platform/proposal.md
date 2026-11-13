# Proposal: add-facet-platform

## Why

功能集市场与 MCP 目录今天寄生在壹座 gateway 进程里，无法独立部署、无法服务壹座之外的编辑器生态；五线品牌中谦面（facet）线承载"分享"这一环（搭→分享→服务化），需要自己的平台。拷问已完结（2026-10-03），全部决策在案：谦面为独立资源面平台，registry 归屋为其组件（ADR-0015，轻归屋），萬星 facade 部署数据源先行解耦为 HTTP。

## What Changes

- **S0 解耦前置**：萬星 facade 对 pack 部署数据的 4 处进程内 import 改为只读内部 HTTP API（internal token），S1 后仅换 env 指向。
- **S1 谦面抽身**：pack 市场从 gateway/packs.js 迁出为独立服务（仓内 `facet/` 目录），`packs.db` 迁出 gateway 数据根，独立域名 `facet.finddatatech.cloud`，canonical 部署路径（GHA→TCR→GitOps）；deploy 链（agent-serving + sub2api）随迁。
- **壹座深度打通**：壹座 `/api/packs` 变同源反向代理（转发已验证身份），前端零改动；双拓扑写代码、fd-prod 单验收。
- **身份双通道**：同一 Logto 租户——谦面直连用户走 OIDC 授权码自持 session；壹座嵌入走代理转发身份。
- **开放面**：公开 pack 匿名可浏览/详情/下载 skill.md；上传/订阅/部署需登录；creators 白名单 v1 不变。
- **独立薄 SPA**：复用 `web/src/components/packs` 组件挂在谦面域名。
- **S2 registry 轻归屋**：谦面 UI 聚合 MCP 卡片（registry-bridge 读数）+ DEPLOY.md 归属文档；registry 软件/域名/GitOps 位置不动（ADR-0015）。
- **S3 多编辑器 CLI**：npm `@finddata/facet`——技能安装到 Claude Code 与 Cursor + skill.md 下载面；MCP 引用只打印 URL 与凭据提示（registry MCP 连接是 per-user JWT，匿名不可连——已探针实证）。
- **S4 一键流**：壹座 UI 串起 preset→桥→草稿→发布→部署为萬星 Agent 服务。
- **开源**：`facet/` 随公开快照仓发布。

## Capabilities

### New Capabilities

- `facet-platform`: 独立谦面服务的平台契约——独立部署形态与数据归属、身份双通道（OIDC/代理转发）、壹座同源代理打通、匿名开放面、面向服务面的内部部署 API、MCP 卡片聚合（registry 轻归屋）。
- `facet-editor-cli`: 多编辑器安装面——`@finddata/facet` CLI（Claude Code/Cursor 技能安装）、skill.md 下载面、MCP 引用的凭据提示边界、下载即快照语义。

### Modified Capabilities

- `pack-marketplace`: 市场归属从 gateway 迁至 facet 服务（"registry lives at the gateway" 与 "Subscription records at the gateway" 重塑为 facet 归属）；浏览面从"全认证"改为"公开 pack 匿名可浏览"；新增 preset→服务一键流 requirement。

## Impact

- **代码**：`gateway/packs.js`（迁出）、`gateway/wanxing/index.js:69-103`（4 调用点改 HTTP）、`web/src/lib/packs-api.ts`（不动，代理保持同源）、`web/src/components/packs/`（抽出复用）、新 `facet/` 目录、`preset-pack-bridge` 流（S4 串联）。
- **配置/部署**：新 GitOps app + 域名 `facet.finddatatech.cloud` + Logto 新 application；`AGENT_SERVING_PACKS_URL`/`PACKS_PUBLIC_BASE` 重指（平滑迁移：旧 skill-md 路由保留）；壹座 `PACK_MARKETPLACE` 语义变为"嵌入谦面"。
- **数据**：`packs.db` 文件迁移（schema 不变）；订阅/部署记录随迁，身份为同一 Logto 用户键，连续。
- **不改**：cell 安装面（pack-store/mypacks/浏览器搬运 D8）、registry 软件与域名、runner（归萬星，ADR-0004）、pack manifest 校验规则、creators 门控。
- **文档/术语**：CONTEXT.md 已落 谦面/注册处 词条；ADR-0015 已落盘。
