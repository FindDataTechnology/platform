# app-center Specification

## Purpose

壹座 web 的发现面（`/apps`）：以单一网格呈现运行在平台上的全部生态产品——每个产品一张卡，职责一句话、可用性如实标注、连接状态与设置「连接」分节同源，「打开」看产品本体、「去连接」直达对应连接卡。项目联邦而非融合：各产品保持自己的站点与身份，这里只聚合入口与状态。

## Requirements

### Requirement: 应用中心导航与路由

登录用户可从主导航进入应用中心页（`/apps`），与既有页面同级。

#### Scenario: 导航项可达

- WHEN 登录用户打开壹座 web
- THEN 侧边栏主导航含「应用」项（testid `nav-apps`）
- WHEN 点击该导航项
- THEN 路由到 `/apps`，应用中心页渲染（testid `app-center-page`）

### Requirement: 统一网格——一卡一生态产品

应用中心 SHALL 以**单一网格**呈现当前用户可达的全部生态产品，每个产品恰好一张卡，所有卡片形态一致：品牌图标、名称、一句职责、可用性徽章、连接徽章、动作区。应用中心是这些条目的唯一页面：智能体页原「应用」子页退役（openspec: agent-catalog），其条目全部并入本网格。

条目来自两路并合为一：
- **品牌事实**（静态单源，不依赖网络）：壹座、谦面、萬星、识律、柏讯五个品牌各一张卡；
- **目录产品**（`GET /api/catalog` 中 `kind` 为 `external-service`、`link` 或 `nango-connect` 的条目，服务端已按角色过滤）：每条一张卡，SHALL 归属到一个品牌——条目显式 `line` 字段优先，否则按 id 前缀 `<brand>-` 推断。`nango-connect` 条目 SHALL 按其既有连接代理契约（openspec: agent-catalog, App entries and the Nango connect broker）以「连接」为主行动（`POST /api/apps/:id/connect` 铸会话后跳转 Connect UI），失败显性报错。

网格顺序 SHALL 为品牌序（壹座 → 谦面 → 萬星 → 识律 → 柏讯），每张品牌卡之后紧随其归属的产品卡；无法归属的产品卡排在末尾。平台自身（壹座）SHALL 以锚点卡呈现「你正在这里」，不带外链。页面 SHALL 不再出现「产品线」「平台应用」两个分区标题（CONTEXT.md「生态产品」词条的 Avoid 用词）。

动作区：已接入线看板的产品（谦面、萬星、柏讯）SHALL 以「看板」为主行动，进入 `/boards/<line>`，并 SHALL 保留「打开原站」为次要动作，在新标签打开其自有域名。看板主行动的可用条件 SHALL 是**该看板所需凭据已连接**——谦面 → `facet-market`，柏讯 → `line-wire-customer`，萬星无所需凭据则恒可用——MUST NOT 以卡片的聚合连接态为条件（卡片可能聚合与看板无关的连接）。看板所需凭据未连接时主行动回落为「打开」。线看板功能未开启时，所有卡 SHALL 不渲染「看板」主行动，仅保留「打开」。未接入线看板的外链产品 SHALL 在新标签打开其自有域名；`external-service` 且未禁用内嵌的产品 SHALL 进入平台内嵌页；`nango-connect` 产品 SHALL 以「连接」为主行动（见上）；平台自身无「打开」。

#### Scenario: 单一网格渲染全部卡

- **WHEN** 登录用户打开 `/apps`（目录含随镜像打包的三条产品：壹座·Packs / 萬星·词元 / 萬星·连接器）
- **THEN** 页面只有一个网格容器（testid `app-center-grid`），其中渲染 8 张卡（testid `app-card-{id}`：`yizuo`、`yizuo-packs`、`facet`、`wanxing`、`wanxing-token`、`wanxing-connector`、`lex`、`wire`），且不存在 `app-center-lines` / `app-center-platform-apps` 分区容器或「产品线」「平台应用」标题

#### Scenario: nango-connect 条目以连接为主行动

- **WHEN** 目录含一条 `kind: "nango-connect"` 条目且用户点击其「连接」
- **THEN** 客户端调用 `POST /api/apps/<id>/connect` 并跳转返回的 Connect UI URL
- **WHEN** 该端点返回错误（如认证关闭）
- **THEN** 卡面显性展示错误，不发生跳转

#### Scenario: 品牌序与产品归属

- **WHEN** 单一网格渲染完成
- **THEN** 卡片 DOM 顺序为 `yizuo, yizuo-packs, facet, wanxing, wanxing-token, wanxing-connector, lex, wire`——每张产品卡紧随其品牌卡之后

#### Scenario: 平台自身为锚点卡

- **WHEN** 单一网格渲染完成
- **THEN** `yizuo` 卡显示「你正在这里」（testid `app-card-yizuo-self`），不渲染 `app-card-yizuo-open`

#### Scenario: 已接入看板的线以看板为主行动

- **WHEN** 用户点击 `facet`、`wanxing` 或 `wire` 卡的「看板」（testid `app-card-{id}-board`）
- **THEN** 路由到 `/boards/facet`、`/boards/wanxing` 或 `/boards/wire`
- **WHEN** 同一张卡渲染完成
- **THEN** 同时渲染「打开原站」次要动作（testid `app-card-{id}-open`），点击后在新标签打开该产品自有域名

#### Scenario: 柏讯看板入口只看自己的凭据

- **WHEN** `/api/connections` 报告 `line-wire-customer` 为 `connected`、`paper-trading` 为 `disconnected`
- **THEN** `wire` 卡连接徽章为 `data-state="partial"`，但仍渲染「看板」主行动（testid `app-card-wire-board`）
- **WHEN** `/api/connections` 报告 `line-wire-customer` 为 `disconnected`
- **THEN** `wire` 卡不渲染 `app-card-wire-board`，主行动为「打开」

#### Scenario: 直达外链与内嵌页

- **WHEN** 用户点击 `lex` / `yizuo-packs` / `wanxing-connector` 卡的「打开」
- **THEN** 在新标签打开该产品自有域名（`https://lex.finddatatech.cloud`、目录条目的 `url`）
- **WHEN** 用户点击 `wanxing-token`（`external-service`，未禁用内嵌）卡的「打开」
- **THEN** 路由到 `/external/wanxing-token`

#### Scenario: 早期状态如实降级

- **WHEN** 某品牌尚为占位/骨架（识律现状）
- **THEN** 该卡可用性徽章如实标注「建设早期」（testid `app-card-{id}-early-badge`），「打开」仍直达（不隐藏、不虚构可用性）；已接入看板的品牌（谦面、萬星、柏讯）不渲染该徽章——`wire` 卡不存在 `app-card-wire-early-badge`

#### Scenario: 线看板未开启时回落

- **WHEN** 线看板功能未开启
- **THEN** `facet`、`wanxing`、`wire` 三张卡均不渲染 `app-card-{id}-board`，主行动为「打开」并在新标签打开自有域名

#### Scenario: 目录不可用时品牌卡照常

- **WHEN** `GET /api/catalog` 成功返回但目录为空
- **THEN** 五张品牌卡照常渲染于同一网格，不渲染任何产品卡，页面不报错

#### Scenario: 冷加载失败呈现错误态并可重试

- **WHEN** 用户打开 `/apps` 且本地无目录缓存，`GET /api/catalog` 失败
- **THEN** 五张品牌卡照常渲染于同一网格（不破页），产品区呈现错误态与「重试」控件（testid `app-center-load-error`），MUST NOT 静默停在半屏
- **AND** 首次失败后系统 SHALL 自动退避重试一次，仍失败才呈现错误态
- **WHEN** 用户点击「重试」且拉取成功
- **THEN** 全量网格（品牌卡 + 目录产品卡）渲染，错误态消失

#### Scenario: 有缓存时后台校验失败保持静默

- **WHEN** 本地已有目录缓存，进入页面后的后台校验请求失败
- **THEN** 网格继续以缓存内容渲染，不出现错误态打断阅读；目录返回空时仍照常只渲染品牌卡


### Requirement: 连接徽章与去连接

每张卡 SHALL 声明零个或多个「所需连接」id，映射单源维护，且每个 id MUST 是 `GET /api/connections` 已知的连接 id。映射为：壹座·Packs（`yizuo-packs`）→ `registry`；谦面（`facet`）→ `facet-market`；萬星·词元（`wanxing-token`）→ `ciyuan-account`（词元账号，取代已退役的 `line-wanxing-caller`）；萬星·连接器（`wanxing-connector`）→ `connector`；识律（`lex`）→ `line-lex`；柏讯（`wire`）→ `line-wire-customer`、`paper-trading`；壹座（`yizuo`）与萬星（`wanxing`）无所需连接。

页面加载时 SHALL 读取一次 `GET /api/connections`，为每张有所需连接的卡渲染连接徽章（testid `app-card-{id}-connection-badge`，`data-state` 为聚合态），聚合规则：所需连接全部 `connected` → `connected`（已连接）；任一 `stale` → `stale`（需重连）；部分 `connected` 且无 `stale` → `partial`（部分连接）；其余 → `disconnected`（未连接）。无所需连接的卡 SHALL 不渲染连接徽章。

聚合态非 `connected` 时，卡片 SHALL 提供「去连接」动作（testid `app-card-{id}-connect`），导航至 `/settings/connections?panel=<首个非 connected 的所需连接 id>`；聚合态为 `connected` 时不渲染该动作。

`GET /api/connections` 失败（非 2xx、401、网络错误）时，SHALL 不渲染任何连接徽章与「去连接」，其余卡面与动作照常。徽章与动作 SHALL 不显示任何凭据材料（端点本身即只读状态投影）。

#### Scenario: 全部未连接

- **WHEN** 用户在无任何连接的全新环境打开 `/apps`
- **THEN** `yizuo-packs`、`facet`、`wanxing-token`、`wanxing-connector`、`lex`、`wire` 六张卡渲染 `data-state="disconnected"` 的连接徽章与「去连接」；`yizuo`、`wanxing` 两张卡不渲染连接徽章也不渲染「去连接」

#### Scenario: 去连接直达对应连接卡

- **WHEN** 用户点击 `wanxing-token` 卡的「去连接」
- **THEN** 路由到 `/settings/connections?panel=ciyuan-account`，连接分节中萬星·词元（词元账号）卡处于高亮

#### Scenario: 词元账号绑定后卡片翻绿

- **WHEN** `/api/connections` 报告 `ciyuan-account` 为 `connected`
- **THEN** `wanxing-token` 卡连接徽章为 `data-state="connected"`，不渲染 `app-card-wanxing-token-connect`

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

### Requirement: 文案与质量线

五语文案 SHALL 齐全（check-locales 门），e2e 哨兵 SHALL 覆盖导航可达 + 统一网格渲染（品牌卡与目录产品卡同一网格、无分区标题、品牌序）+ 卡片直达行为 + 连接徽章四态与「去连接」深链落到连接分节。

#### Scenario: 五语齐

- **WHEN** 运行 locales 校验
- **THEN** `nav.apps` 与 `appCenter.*`（含 `appCenter.connection.*` 四态与「去连接」文案）在 en/es/fr/ja/zh-CN 五语言文件中键集一致，且不再含 `appCenter.linesHeading` / `appCenter.appsHeading`

#### Scenario: e2e 哨兵

- **WHEN** 运行 app-center e2e spec
- **THEN** 导航项存在、单一网格渲染 8 张卡且顺序为品牌序、分区容器不存在、锚点卡无外链、早期徽章如实、外链 href 正确、内嵌产品路由到 `/external/:id`、全新环境六卡「未连接」两卡无徽章、「去连接」落到 `/settings/connections?panel=…` 并高亮对应卡、模拟 `partial`/`stale`/`connected`/端点失败四种响应时徽章与动作行为符合要求——全绿

### Requirement: 发现面卡片的在场信号呈现

`/apps` 的每个产品卡 SHALL 以平台自身的状态语义承载「真实在场信号」：连接状态用状态词表（`status-running` 已连接 / `status-paused` 未连接 / `status-failed` 连接失败）配文字标签呈现，可用性如实标注（不可用须显式文案而非静默隐藏）；卡片 MUST NOT 以品牌色图标墙作为主要视觉主张，蓝色的使用 MUST 限定在唯一主操作与活体信号上。搜索与筛选控件 SHALL 位于页头之下，页头标题 MUST 为视口第一读点。

#### Scenario: 连接态非色盲单通道

- WHEN 某产品已连接、另一产品未连接
- THEN 两卡分别以 running 与 paused 状态胶囊呈现，且胶囊各带可读文案，色觉障碍用户仅凭文字即可区分

#### Scenario: 页头不被筛选控件压过

- WHEN 用户打开 `/apps`
- THEN 页面标题先于搜索/筛选控件出现，标题是该视图唯一的一级读点
