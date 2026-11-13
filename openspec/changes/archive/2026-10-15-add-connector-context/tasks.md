# Tasks

- [x] 1. `ConnectorConnectPanel` 标题下加产品说明（连接器是什么、令牌给谁用）与
  「了解产品」链接（design D1）：链接新标签打开官网产品介绍页，按界面语言选页（i18n 当前语言 zh 前缀 → `/zh/products/wanxing-connector/`，否则 `/products/wanxing-connector/`）；说明与链接常显（卡片在 `connectorConnection` 未知时不渲染的既有规则不变）
  - 实现：`ConnectorConnectPanel.tsx` 标题行后加 `data-testid="connector-context-line"`（`contextLine` + 链接 `connector-learn-more`）；`connectorLearnMoreUrl(lang)` 落 `web/src/lib/connector-mint.ts`（node 测试可 import）
- [x] 2. 五语 locale 键（en / zh-CN / ja / fr / es）全配（design D2：`contextLine` + `learnMore`），`check:locales` 绿
  - 证据：`check:locales` 1292 键 × 5 语全等绿
- [x] 3. `agents.json` 的 `wanxing-connector.description` 纠偏为实际口径（design D3：SaaS 连接网关 / 统一凭据 / 为 agent 铸令牌，与官网页基线一致）
  - 实现：`数据连接器——连接企业数据库与外部数据源，铸造个人访问令牌` → `SaaS 连接网关——统一托管外部服务凭据，为 agent 铸造访问令牌`（url 不变）
- [x] 4. 测试：组件测试断言说明文案与链接（含按语言选页）；既有套件全绿（web 单测 + 相关 e2e 哨兵）
  - 新增 `scripts/test-app-center-connector.mjs` 4 断言全绿（语言选页 zh 家族→中文页 / en/es/fr/ja→英文页；五语键非空且 en≠zh；agents.json 口径与旧文案缺失断言）
  - 全套 `test:unit` 1361/1362：唯一红 `test-worker-pool.mjs` 单独复跑 4/4 绿（并发态存量 flake，非本变更回归）
  - `web typecheck` 绿（tsc 无输出）；`biome check` 本变更 9 文件全绿
  - oxfmt 格式门：本变更 2 个 md 文件格式绿；仓内 10 个存量文件格式债为基线守卫（`git stash` 复证同红，非本变更引入，未动）
- [x] 5. 目检：本地/预览实机看卡片两态（已连接/未连接）与链接可达
  - en 态：`lineText: "Connect your SaaS accounts once and mint access tokens for agent platforms. Learn more"`、`linkHref=https://www.finddatatech.cloud/products/wanxing-connector/`、`target=_blank`
  - zh-CN 态（`localStorage["platform.locale"]="zh-CN"` 后重载）：`连一次 SaaS 账户，为 agent 平台铸造访问令牌。 了解产品`、`linkHref=https://www.finddatatech.cloud/zh/products/wanxing-connector/`、`target=_blank`；截图存证
- [x] 6. 出片上线：commit → 平台镜像 → GitOps roll → 线上验收（MCP 市场卡片说明与链接在产；应用中心卡片描述纠偏在产；「了解产品」链接可达官网页）
  - 生产已就绪证据（pod `platform-5bdd4f6448-z4h4k`，镜像 `platform:sha-ac4aec2`
    ≙ paas 3e4591e；GitOps 88fac0e 已滚）：
    ① 说明+链接在产——pod 内 `/app/web/dist/assets/ExtensionsPage-da46cfkF.js`
       含 `connector-learn-more`；
    ② 应用中心卡片描述纠偏在产——pod 内 `/app/agents.json` =
       「SaaS 连接网关——统一托管外部服务凭据，为 agent 铸造访问令牌」；
    ③ 「了解产品」文案在产——pod 内 `index-iIBAjIcz.js` 含「了解产品」。
  - 本次独立复跑复核出片链（判路 `fd-build-channel pick platform` → scs001
    公开仓免费线）：快照 HEAD df5ebf7 → image run 38654102244 绿 →
    relay `OK yizuo/platform:sha-5fe955c` → ccr skopeo inspect 可拉
    （digest a10a66f7…）。因生产已在跑内容等价的 ac4aec2，未再重复 bump。
  - 两枚沿途事实：① gitleaks 报 1 finding = `scripts/test-search-relay-lane.mjs`
    的 dummy 常量 `sk-lane-internal-123`（sk- 前缀误触 generic-api-key 熵规则），
    按既有惯例登记 `.gitleaks.toml` path 例外（commit df5ebf7）而非用
    `--skip-gitleaks` 绕过；② 快照只构建不推送的根因 = 快照生成器刻意排除
    `.github/workflows/image.yml`（内部拓扑），公开线仅有 image-build-check.yml
    （load, no push），出片需在快照内补一条 publish 用 image.yml（本次已在
    scs001 侧落地）；③ 快照 CI run 38653482723 红于两个未使用变量
    （`scripts/probe-connector-welcome-context.mjs:72`、
    `scripts/test-paper-trading-credentials.mjs:86`）——他人/他会话在途 lint 债，
    本变更未触碰，非本变更回归。
- [x] 7. 归档 — openspec archive 归档为 2026-10-15-add-connector-context；主 spec connector-credentials 同步（MODIFIED 需求保留全部既有场景 + 新增「卡片产品说明与了解产品链接」场景），validate --specs 142 items 全绿（0 失败）
