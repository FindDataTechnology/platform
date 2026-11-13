## 1. 服务端（gateway 挂载）

- [x] 1.1 `gateway/index.js`：解析 `PACK_ANONYMOUS_READ`（默认关）+ `OFFICIAL_AUTHOR_EMAILS` 传入注册参数
- [x] 1.2 `gateway/packs.js`：`GET /api/packs/official`（匿名恒可读，注册于 `/:id` 之前；三段聚合——
      blueprint 模板 / facade+assistant 对话助手 / featured 策展，前两段名单内 only、featured 段保留
      名单外策展且 official:first 排序）；list/detail 行携带读时推导的 `official` 布尔（flag 恒在，
      空名单=全 false 非缺键）；facet 挂载同参（共享 registry 一份真源）
- [x] 1.3 `scripts/test-official-showcase.mjs` 5 用例：名单判定（大小写不敏感/名单外结构相似不进）、
      名单变更读时重推导零写库、三段聚合+private 零出现+无泄漏、空名单诚实空段+策展 featured 保留
      （D5）、匿名开关矩阵（开=公开可读+写 401；关=墙+showcase 仍匿名）
- [x] 1.4 既有 packs 套件零扰动（facet-platform/publish-gate/market-revenue-share/vendor-supply-open/
      pack-files-market/owner-surface/owner-iteration/facet-cli-publish 共 77/77）

## 2. 前端（壹座 web）

- [x] 2.1 pre-login 壳增官方资产段（`OfficialShowcaseStrip`）：hero 布局挂 hero 侧、neutral 布局挂卡下方；
      空/失败**不渲染**（登录页永不出错不添堵）；卡片点击只出登录引导行，零写请求
- [x] 2.2 `PackMarketView` 增「官方」筛选片（URL `?official=1` 持久化，沿 size-filter 惯例；chip 仅在
      服务端确有 official 行时渲染，pre-upgrade 行透传不过滤）+ 卡片官方徽章
- [x] 2.3 i18n 五语言同批（`loginHero.official.*`、`packs.market.official/officialBadge`）；locale 闸绿
- [x] 2.4 e2e `e2e/official-showcase.spec.js` 3 条绿（strip 卡片+点击引导+零写、空答案不渲染、
      市场筛选+徽章）。**实施坑**：playwright 路由后注册先匹配（catch-all 必须先注册）；auth mock 的
      mode:null=「加载失败屏」而非匿名（匿名=mode:"none"）；`/settings/packs` 已 301 到 `/agents?tab=market`

## 3. 前端（谦面 facet，同仓）

- [x] 3.1 facet 复用主 web 的 `PackMarketView`（vite alias 单源）——官方筛选/徽章一处改动两面生效；
      facet 挂载补同一 roster env
- [x] 3.2 facet i18n 同源（共享 locale 文件）；facet 单测绿（facet-platform 9/9）

## 4. 验收

- [x] 4.1 `openspec validate --strict` 绿 + 单测（新 5/5+回归 77/77）+ typecheck/biome（触碰文件）绿 + locale 闸绿
- [ ] 4.2 部署验收（env 打开后随滚版班）：匿名开壹座产品页眼见官方团队模板卡片非空；
      匿名 `GET /api/packs/official` 200 三段；匿名写 401；private pack 匿名 404
  - **2026-10-31 事后回填（台账 §15.109）：四条 API 判据全部达成。** 真网关是
    `platform.finddatatech.cloud`（**坑**：`www.finddatatech.cloud` 是 Astro 营销站，任意路径都返
    HTML 200，只看 status 会被假绿骗；判匿名 API 必须看 content-type / 首字符）：
    匿名 `GET /api/packs` → 200（total 75）；`GET /api/packs/official` → 200 三段齐
    templates 16 / assistants 35 / featured 2；匿名 `POST /api/packs` → 401；
    公开包详情匿名 → 200，不存在 id → 404（不泄存在性）。
  - **仍未验**：首条「匿名产品页**眼见**官方团队模板卡片非空」——SSR 壳内无该文案（SPA 渲染），
    本次未做浏览器眼见。故本条**不勾**，只记 API 侧达成。
- [ ] 4.3 名单未配置的部署眼见「暂无官方资产」空态（服务端已证 200 空段；真机眼见随班）
  - **2026-10-31 事后回填（台账 §15.109）：降一档达成。** 空名单空态由单测钉住
    （`scripts/test-official-showcase.mjs:154`「showcase with an empty roster: official segments
    empty; curated featured stays (D5)」）；线上名单已配置（16/35/2 非空），空态**无真机可眼见**。
    比原判据「真机眼见」弱一档，如实记录，故本条**不勾**。
- 注：`e2e/packs.spec.js` 两条既有失败（body-form installs / subscribe report wizard）经定向 stash
  实证为 pre-existing（HEAD 服务端代码同样复现），非本批引入，随原车道归因。
