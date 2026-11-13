# add-official-pack-showcase

## Why

「未登录也能看到官方资产」今天只完成了三分之二：市场引擎的匿名读**规格已钉死**（`pack-marketplace`
「Browse, search, and inspect」：未登录访客 SHALL 能列出/搜索/查看/下载公开包），谦面挂载
（`facet/index.js`）已按 `anonymousRead: true` 落实并有测试矩阵；但**壹座 gateway 挂载没传这个参数**
（`gateway/index.js` 的 `registerPackRoutes` 走默认 false）——壹座自己的市场对未登录仍是登录墙。
同时「官方资产」没有组织化呈现：五枚官方团队种子、三枚官方助手与官方精选散在 89 包里，
访客只能靠翻。产品落地页（registry 根路径）有聚合计数+策展精选，但那是 MCP registry 侧的
featured，不是壹座·智能体基础设施的官方集合。

路线文档（`docs/roadmap-agents-native-teams.md` 线3）要求：原生多语言（另案）+ **公开文档与
官方资产未登录可见**（本案）。

## What Changes

- **壹座 gateway 市场开匿名读**：`registerPackRoutes` 增 `anonymousRead` 传参，默认**关**
  （部署侧 env `PACK_ANONYMOUS_READ=1` 打开）；语义与谦面挂载逐字节同源——公开包可浏览/查详情/
  读版本史/下载技能正文，private/unlisted 一律 404，全部写路由（发布/订阅/改分类）保持 401。
  这不是新权限，是把 `pack-marketplace` 既有规格要求在壹座挂载补齐。
- **官方集合读面**：新增 `GET /api/packs/official`（匿名可读），聚合三类官方资产——
  官方**团队模板**（fleet template packs）、官方**助手**（assistant packs）、官方**精选**
  （curation featured）。官方判定源 = 部署侧官方作者名单（env，默认含平台作者账号），
  呈现层打「官方」徽章；名单外作者即使 featured 也不进官方集合（featured 只进精选段）。
- **未登录呈现入口**：壹座 pre-login SPA 壳（login-hero 既有壳，无需登录即可渲染）新增
  「官方资产」段：官方团队模板 + 官方精选卡片，点卡片对未登录访客给「登录后安装」引导
  （复用既有 `Anonymous subscribe attempts get a login guidance bar` 语义）；谦面市场
  `#/packs` 列表增「官方」筛选片。
- **不改**：可见性语义（public/private/unlisted）、发布门、安装链、curation 端点权限、
  `pack-visibility` 的「探测教不出东西」原则。

## Capabilities

### New Capabilities

- `official-pack-showcase`: 官方资产集合的判定、读面与未登录呈现——官方团队模板/助手/精选聚合，
  匿名可读，登录墙前可见。

### Modified Capabilities

- `pack-marketplace`: 壹座 gateway 挂载补齐既有规格里的匿名读要求（env 开关，默认关）；
  官方徽章随列表/详情读面携带。

## Impact

- **gateway**：`gateway/index.js`（传 `anonymousRead` + env 解析）、`gateway/packs.js`
  （新增 `/api/packs/official` 只读端点，官方名单解析与三类聚合，零新存储——聚合自既有 packs.db 行）。
- **web**：pre-login 壳组件新增官方资产段（`web/src/pages/LoginPage.tsx` 或 login-hero 槽位）；
  `PackMarketView` 增「官方」筛选片；i18n 五语言同批（locale 闸绿）。
- **facet（姊妹面，同仓）**：`facet/web/src/App.tsx` 的 packs 视图增「官方」筛选（同一端点语义，
  facet 已有匿名读，无需开关）。
- **测试**：复用 `scripts/test-facet-platform.mjs` 的匿名矩阵在 gateway 挂载跑一遍（public 可读/
  private 404/写 401/官方集合不含名单外作者）；新增 `scripts/test-official-showcase.mjs`。
- **不影响**：谦面既有匿名面（零改动即合规）、registry 落地页（另案演进）、安装与订阅链。
