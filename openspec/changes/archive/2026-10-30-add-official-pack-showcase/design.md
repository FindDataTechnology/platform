# Design: add-official-pack-showcase

## Context

匿名读的规格与实现都已经存在，只是没接到壹座：

- **规格**：`pack-marketplace`「Browse, search, and inspect」已写明「Unauthenticated visitors SHALL be
  able to list, search, inspect, and download the content of public packs without any account」。
- **实现**：`gateway/packs.js:1150` 的 `anonymousRead = false` 默认参数 + `:1302` 的匿名 viewer
  （`{ email: "", groups: [] }`，`visibleTo()` 只放行 public、unlisted 门保持关闭）。谦面挂载
  （`facet/index.js:159`）传了 `anonymousRead: true`，`scripts/test-facet-platform.mjs` 2.3 有完整矩阵。
- **缺口**：`gateway/index.js:762` 的壹座挂载没传该参数 → 壹座市场对未登录是墙；
  「官方」无判定源、无聚合读面、无登录墙前呈现。

官方资产的存量：五枚团队种子（`docs/fleet-templates/*.seed.json`）、三枚官方助手
（`docs/official-packs/*-manifest.json`）、官方精品（curation featured）。它们都是 packs.db 行，
聚合读面零新存储。

## Goals / Non-Goals

**Goals**

- 未登录访客在壹座登录墙前就能看到「官方有哪些团队模板、哪些助手、哪些精选」。
- 官方判定只有一个真源（部署侧名单），作者不可自报。
- 匿名读语义与谦面逐字节同源——同一套代码路径，不造第二份可见性逻辑。

**Non-Goals**

- **不动可见性语义**：public/private/unlisted 的判定、探测不泄露原则、unlisted 门全部原样。
- **不做公开的「任意包」全文索引或 SEO 面**：本案权益是官方资产呈现，不是整站公开化。
- **不改 registry 落地页**（`registry-product-home` 另案演进）。
- **不做 pack 内容的多语言副轨**（那是姊妹案 `add-official-packs-i18n`）。

## Decisions

### D1 · 匿名读走 env 开关、默认关

`PACK_ANONYMOUS_READ=1` 才开。理由：壹座 gateway 的市场挂载承载订阅写面，租户部署方应当显式
选择把读面开放到登录墙之外；默认关保证存量部署零行为变化。谦面挂载不受影响（它已显式开）。

### D2 · 官方判定 = 部署侧作者名单，不进 manifest

`OFFICIAL_AUTHOR_EMAILS`（逗号分隔）解析为名单；`official` 徽章在**读时**从名单推导
（不落库、不随版本冻结）。理由：名单改了徽章即时跟着变，无需数据迁移；作者自报官方的
攻击面（publish 任意 manifest 字段）被结构性排除。

### D3 · 官方集合端点是聚合投影，不是新存储

`GET /api/packs/official` 在读时扫 packs.db 公开行，按「携带 fleet 段 → 模板段」「携带
assistant/facade serving → 助手段」「featured → 精选段」三段聚合。理由：五枚种子 + 三枚助手
量级极小，扫表成本可忽略；任何持久化的「官方集合表」都会引入与 packs.db 的第二个真源。

### D4 · 登录墙前呈现挂在既有 pre-login 壳上

login-hero（add-login-hero 6.2）已实现「未登录可渲染的 SPA 壳」，官方资产段作为该壳的一槽位，
数据走 `GET /api/packs/official`（该端点不受 D1 开关影响——它只暴露公开面字段）。
点击卡片未登录 → 既有登录引导条语义（pack-marketplace「Anonymous subscribe attempts get a login
guidance bar」同款），不触发写。

### D5 · 精选段允许名单外 featured 附注呈现

featured 段呈现 featured pack（官方作者优先），名单外精选照常呈现但不带官方徽章。
理由：featured 是运营策展语义（既有 curation 面），与「官方」是两个正交概念，混在一起
会把「运营推荐」伪装成「官方出品」。

## Risks

- **匿名读放大探测面**：开启后，公开包的清单/详情/技能正文可被任意匿名抓取。缓解：
  这是 `pack-marketplace` 规格早已要求的行为，谦面已运行同语义；private/unlisted 的 404
  语义与探测不泄露原则由既有测试矩阵钉住，本案在 gateway 挂载复跑同一矩阵。
- **官方名单配置错误**：名单写错（拼错 email）→ 官方集合静默变空。缓解：空集是如实呈现
  （不是错误），且 tasks 里有部署验收项要求眼见非空。
