# app-center Delta

## ADDED Requirements

### Requirement: 统一网格——一卡一生态产品

应用中心 SHALL 以**单一网格**呈现当前用户可达的全部生态产品，每个产品恰好一张卡，所有卡片形态一致：品牌图标、名称、一句职责、可用性徽章、连接徽章、动作区。

条目来自两路并合为一：
- **品牌事实**（静态单源，不依赖网络）：壹座、谦面、萬星、识律、柏讯五个品牌各一张卡；
- **目录产品**（`GET /api/catalog` 中 `kind` 为 `external-service` 或 `link` 的条目，服务端已按角色过滤）：每条一张卡，SHALL 归属到一个品牌——条目显式 `line` 字段优先，否则按 id 前缀 `<brand>-` 推断。

网格顺序 SHALL 为品牌序（壹座 → 谦面 → 萬星 → 识律 → 柏讯），每张品牌卡之后紧随其归属的产品卡；无法归属的产品卡排在末尾。平台自身（壹座）SHALL 以锚点卡呈现「你正在这里」，不带外链。页面 SHALL 不再出现「产品线」「平台应用」两个分区标题（CONTEXT.md「生态产品」词条的 Avoid 用词）。

「打开」动作：外链产品在新标签打开其自有域名；`external-service` 且未禁用内嵌的产品进入平台内嵌页；平台自身无「打开」。

#### Scenario: 单一网格渲染全部卡

- **WHEN** 登录用户打开 `/apps`（目录含随镜像打包的三条产品：壹座·Packs / 萬星·词元 / 萬星·连接器）
- **THEN** 页面只有一个网格容器（testid `app-center-grid`），其中渲染 8 张卡（testid `app-card-{id}`：`yizuo`、`yizuo-packs`、`facet`、`wanxing`、`wanxing-token`、`wanxing-connector`、`lex`、`wire`），且不存在 `app-center-lines` / `app-center-platform-apps` 分区容器或「产品线」「平台应用」标题

#### Scenario: 品牌序与产品归属

- **WHEN** 单一网格渲染完成
- **THEN** 卡片 DOM 顺序为 `yizuo, yizuo-packs, facet, wanxing, wanxing-token, wanxing-connector, lex, wire`——每张产品卡紧随其品牌卡之后

#### Scenario: 平台自身为锚点卡

- **WHEN** 单一网格渲染完成
- **THEN** `yizuo` 卡显示「你正在这里」（testid `app-card-yizuo-self`），不渲染 `app-card-yizuo-open`

#### Scenario: 直达外链与内嵌页

- **WHEN** 用户点击 `facet` / `wanxing` / `lex` / `wire` / `yizuo-packs` / `wanxing-connector` 卡的「打开」
- **THEN** 在新标签打开该产品自有域名（`https://facet.finddatatech.cloud`、`https://wanxing.finddatatech.cloud`、`https://lex.finddatatech.cloud`、`https://wire.finddatatech.cloud`、目录条目的 `url`）
- **WHEN** 用户点击 `wanxing-token`（`external-service`，未禁用内嵌）卡的「打开」
- **THEN** 路由到 `/external/wanxing-token`

#### Scenario: 早期状态如实降级

- **WHEN** 某品牌尚为占位/骨架（识律、柏讯现状）
- **THEN** 该卡可用性徽章如实标注「建设早期」（testid `app-card-{id}-early-badge`），「打开」仍直达（不隐藏、不虚构可用性）；已可用品牌（如谦面）不渲染该徽章

#### Scenario: 目录不可用时品牌卡照常

- **WHEN** `GET /api/catalog` 失败或返回空目录
- **THEN** 五张品牌卡照常渲染于同一网格，不渲染任何产品卡，页面不报错

### Requirement: 连接徽章与去连接

每张卡 SHALL 声明零个或多个「所需连接」id，映射单源维护，且每个 id MUST 是 `GET /api/connections` 已知的连接 id。本 change 的映射为：壹座·Packs（`yizuo-packs`）→ `registry`；谦面（`facet`）→ `facet-market`；萬星·词元（`wanxing-token`）→ `line-wanxing-caller`；萬星·连接器（`wanxing-connector`）→ `connector`；识律（`lex`）→ `line-lex`；柏讯（`wire`）→ `line-wire-customer`、`paper-trading`；壹座（`yizuo`）与萬星（`wanxing`）无所需连接。

页面加载时 SHALL 读取一次 `GET /api/connections`，为每张有所需连接的卡渲染连接徽章（testid `app-card-{id}-connection-badge`，`data-state` 为聚合态），聚合规则：所需连接全部 `connected` → `connected`（已连接）；任一 `stale` → `stale`（需重连）；部分 `connected` 且无 `stale` → `partial`（部分连接）；其余 → `disconnected`（未连接）。无所需连接的卡 SHALL 不渲染连接徽章。

聚合态非 `connected` 时，卡片 SHALL 提供「去连接」动作（testid `app-card-{id}-connect`），导航至 `/settings/connections?panel=<首个非 connected 的所需连接 id>`；聚合态为 `connected` 时不渲染该动作。

`GET /api/connections` 失败（非 2xx、401、网络错误）时，SHALL 不渲染任何连接徽章与「去连接」，其余卡面与动作照常。徽章与动作 SHALL 不显示任何凭据材料（端点本身即只读状态投影）。

#### Scenario: 全部未连接

- **WHEN** 用户在无任何连接的全新环境打开 `/apps`
- **THEN** `yizuo-packs`、`facet`、`wanxing-token`、`wanxing-connector`、`lex`、`wire` 六张卡渲染 `data-state="disconnected"` 的连接徽章与「去连接」；`yizuo`、`wanxing` 两张卡不渲染连接徽章也不渲染「去连接」

#### Scenario: 去连接直达对应连接卡

- **WHEN** 用户点击 `wanxing-token` 卡的「去连接」
- **THEN** 路由到 `/settings/connections?panel=line-wanxing-caller`，连接分节中产品线操作卡（含萬星 Caller 行）处于高亮

#### Scenario: 部分连接

- **WHEN** `/api/connections` 报告 `line-wire-customer` 为 `connected`、`paper-trading` 为 `disconnected`
- **THEN** `wire` 卡连接徽章为 `data-state="partial"`，「去连接」指向 `/settings/connections?panel=paper-trading`

#### Scenario: 需重连

- **WHEN** `/api/connections` 报告 `connector` 为 `stale`
- **THEN** `wanxing-connector` 卡连接徽章为 `data-state="stale"`，「去连接」指向 `/settings/connections?panel=connector`

#### Scenario: 已连接不出去连接

- **WHEN** `/api/connections` 报告 `facet-market` 为 `connected`
- **THEN** `facet` 卡连接徽章为 `data-state="connected"`，不渲染 `app-card-facet-connect`

#### Scenario: 状态端点失败时徽章整体缺席

- **WHEN** `GET /api/connections` 返回 500 或 401
- **THEN** 页面不渲染任何 `app-card-*-connection-badge` 与 `app-card-*-connect`，8 张卡的名称、职责、「打开」照常可用

## MODIFIED Requirements

### Requirement: 文案与质量线

五语文案 SHALL 齐全（check-locales 门），e2e 哨兵 SHALL 覆盖导航可达 + 统一网格渲染（品牌卡与目录产品卡同一网格、无分区标题、品牌序）+ 卡片直达行为 + 连接徽章四态与「去连接」深链落到连接分节。

#### Scenario: 五语齐

- **WHEN** 运行 locales 校验
- **THEN** `nav.apps` 与 `appCenter.*`（含 `appCenter.connection.*` 四态与「去连接」文案）在 en/es/fr/ja/zh-CN 五语言文件中键集一致，且不再含 `appCenter.linesHeading` / `appCenter.appsHeading`

#### Scenario: e2e 哨兵

- **WHEN** 运行 app-center e2e spec
- **THEN** 导航项存在、单一网格渲染 8 张卡且顺序为品牌序、分区容器不存在、锚点卡无外链、早期徽章如实、外链 href 正确、内嵌产品路由到 `/external/:id`、全新环境六卡「未连接」两卡无徽章、「去连接」落到 `/settings/connections?panel=…` 并高亮对应卡、模拟 `partial`/`stale`/`connected`/端点失败四种响应时徽章与动作行为符合要求——全绿

## REMOVED Requirements

### Requirement: 五线产品线卡片

**Reason**: 两张网格、两种卡片形态被「统一网格——一卡一生态产品」取代；「产品线」为 CONTEXT.md「生态产品」词条的 Avoid 用词。

**Migration**: 五个品牌卡的渲染、直达外链、「你正在这里」锚点与「建设早期」如实降级全部由新要求承接，testid `app-card-{id}`、`app-card-{id}-open`、`app-card-{id}-self`、`app-card-{id}-early-badge` 不变；分区 testid `app-center-lines` 退役为单一 `app-center-grid`。
