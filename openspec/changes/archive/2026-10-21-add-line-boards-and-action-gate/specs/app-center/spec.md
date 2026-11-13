## MODIFIED Requirements

### Requirement: 统一网格——一卡一生态产品

应用中心 SHALL 以**单一网格**呈现当前用户可达的全部生态产品，每个产品恰好一张卡，所有卡片形态一致：品牌图标、名称、一句职责、可用性徽章、连接徽章、动作区。

条目来自两路并合为一：
- **品牌事实**（静态单源，不依赖网络）：壹座、谦面、萬星、识律、柏讯五个品牌各一张卡；
- **目录产品**（`GET /api/catalog` 中 `kind` 为 `external-service` 或 `link` 的条目，服务端已按角色过滤）：每条一张卡，SHALL 归属到一个品牌——条目显式 `line` 字段优先，否则按 id 前缀 `<brand>-` 推断。

网格顺序 SHALL 为品牌序（壹座 → 谦面 → 萬星 → 识律 → 柏讯），每张品牌卡之后紧随其归属的产品卡；无法归属的产品卡排在末尾。平台自身（壹座）SHALL 以锚点卡呈现「你正在这里」，不带外链。页面 SHALL 不再出现「产品线」「平台应用」两个分区标题（CONTEXT.md「生态产品」词条的 Avoid 用词）。

动作区：已接入线看板的产品（谦面、萬星）SHALL 以「看板」为主行动，进入 `/boards/<line>`，并 SHALL 保留「打开原站」为次要动作，在新标签打开其自有域名。未接入线看板的外链产品 SHALL 在新标签打开其自有域名；`external-service` 且未禁用内嵌的产品 SHALL 进入平台内嵌页；平台自身无「打开」。

#### Scenario: 单一网格渲染全部卡

- **WHEN** 登录用户打开 `/apps`（目录含随镜像打包的三条产品：壹座·Packs / 萬星·词元 / 萬星·连接器）
- **THEN** 页面只有一个网格容器（testid `app-center-grid`），其中渲染 8 张卡（testid `app-card-{id}`：`yizuo`、`yizuo-packs`、`facet`、`wanxing`、`wanxing-token`、`wanxing-connector`、`lex`、`wire`），且不存在 `app-center-lines` / `app-center-platform-apps` 分区容器或「产品线」「平台应用」标题

#### Scenario: 品牌序与产品归属

- **WHEN** 单一网格渲染完成
- **THEN** 卡片 DOM 顺序为 `yizuo, yizuo-packs, facet, wanxing, wanxing-token, wanxing-connector, lex, wire`——每张产品卡紧随其品牌卡之后

#### Scenario: 平台自身为锚点卡

- **WHEN** 单一网格渲染完成
- **THEN** `yizuo` 卡显示「你正在这里」（testid `app-card-yizuo-self`），不渲染 `app-card-yizuo-open`

#### Scenario: 已接入看板的线以看板为主行动

- **WHEN** 用户点击 `facet` 或 `wanxing` 卡的「看板」（testid `app-card-{id}-board`）
- **THEN** 路由到 `/boards/facet` 或 `/boards/wanxing`
- **WHEN** 同一张卡渲染完成
- **THEN** 同时渲染「打开原站」次要动作（testid `app-card-{id}-open`），点击后在新标签打开该产品自有域名

#### Scenario: 直达外链与内嵌页

- **WHEN** 用户点击 `lex` / `wire` / `yizuo-packs` / `wanxing-connector` 卡的「打开」
- **THEN** 在新标签打开该产品自有域名（`https://lex.finddatatech.cloud`、`https://wire.finddatatech.cloud`、目录条目的 `url`）
- **WHEN** 用户点击 `wanxing-token`（`external-service`，未禁用内嵌）卡的「打开」
- **THEN** 路由到 `/external/wanxing-token`

#### Scenario: 早期状态如实降级

- **WHEN** 某品牌尚为占位/骨架（识律、柏讯现状）
- **THEN** 该卡可用性徽章如实标注「建设早期」（testid `app-card-{id}-early-badge`），「打开」仍直达（不隐藏、不虚构可用性）；已可用品牌（如谦面）不渲染该徽章

#### Scenario: 目录不可用时品牌卡照常

- **WHEN** `GET /api/catalog` 失败或返回空目录
- **THEN** 五张品牌卡照常渲染于同一网格，不渲染任何产品卡，页面不报错
