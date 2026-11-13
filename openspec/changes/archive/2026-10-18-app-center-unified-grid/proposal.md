# app-center-unified-grid

## Why

应用中心（`/apps`）现在是两张网格、两种卡片：静态「产品线」五卡（品牌图标 + 一句定位 + 建设早期徽章 + 外链）和 `/api/catalog` 来的「平台应用」三卡（无图标、无状态、按钮分支另一套）。同一品牌被拆在两区（萬星 vs 萬星·词元 / 萬星·连接器；壹座 vs 壹座·Packs），而用户在这个发现面上**看不到自己连没连**——L1（settings-connect-center）已把全部连接状态聚合到 `/api/connections`，却还没有任何消费方。CONTEXT.md「生态产品」词条已定下目标形态（每个姊妹产品单卡、职责一句话、连接状态与设置·连接同源、「打开」看本体、「去连接」直达连接卡），并把现在两个分区标题「产品线」「平台应用」都列为 Avoid 用词。同时 `app-center` spec 在 10-13 删除「平台应用聚合」后，fusion-ia（`d7b51227`）又把三产品数据驱动加了回来，spec 与实现已漂移。这是四刀路线的 L1b，也是 L2a 词元账号线上线后「词元卡徽章翻绿」的落点。

## What Changes

- **统一网格**：应用中心收敛为一张网格、一种卡片，每个生态产品一张卡（平台自身保留一张「你正在这里」锚点卡）。条目两路合一：`appCatalog.ts` 的品牌事实（静态，永不依赖网络）+ `/api/catalog` 的产品条目（动态、按角色过滤）。产品归属到品牌（条目显式 `line` 字段优先，否则按 id 前缀推断），品牌序为主序，产品紧随其品牌之后；无法归属的产品排末尾。
- **卡片统一形态**：品牌图标、名称、一句职责、可用性徽章（「建设早期」如实保留）、连接徽章、动作区——「打开」（外链新开标签 / 内嵌页 `/external/:id` / 平台自身无外链）与「去连接」。
- **连接徽章**：每卡声明所需连接 id 集合（映射单源于 `appCatalog.ts`），状态与 `/api/connections` 同源，四态：已连接 / 部分连接 / 需重连 / 未连接。无映射的卡不出徽章；端点失败或 401 时徽章整体缺席，页面其余照常（与 catalog 失败同款诚实降级）。
- **去连接**：非全连接时出现，直达 `/settings/connections?panel=<首个未连接的 id>`，落到 L1 的连接卡。
- **映射定案**：壹座·Packs ↔ `registry`（registry 弹窗铸造的宿主就是 mcp.finddatatech.cloud，按宿主归属）；谦面 ↔ `facet-market`；萬星·词元 ↔ `line-wanxing-caller`（词元账号现行形态，「萬星 Caller」为旧称）；萬星·连接器 ↔ `connector`；识律 ↔ `line-lex`；柏讯 ↔ `line-wire-customer` + `paper-trading`；壹座 / 萬星 无连接。`search` 是平台服务非产品，不上卡。
- **用词回正**：删除「产品线」「平台应用」两个分区标题；副标题改为生态产品口径。
- **spec 回正**：`app-center` 的「五线产品线卡片」要求改写为「统一网格」要求，正式重新纳入目录驱动的产品卡（取代 10-13 polish-fusion 的删除决定——当时去掉的是与智能体页重复的第二网格，本次是把产品并入同一网格并赋予发现面独有的连接状态，不再是单纯重复入口）；新增「连接徽章与去连接」要求；e2e 哨兵同步。
- **i18n 五语**：新增 `appCenter.connection.*`，改写 `appCenter.subtitle`，删除 `appCenter.linesHeading` / `appCenter.appsHeading`。

非目标：智能体页「应用」tab（工作面，原样保留）；`/api/connections` 与各凭据模块（只消费不改）；`agents.json` 产品条目内容（GitOps 数据，不改）；谦面双胞胎命名——连接分节里 `registry` 条目叫「谦面·工具市场」而其宿主产品卡叫「壹座·Packs」，本 change 沿用两处现名、映射按宿主走，改名另议；L2a 词元账号形态。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `app-center`：「五线产品线卡片」要求改写为「统一网格」——一卡一生态产品、单一卡片形态、品牌序、目录产品归属品牌并入同一网格、建设早期如实降级保留；新增「连接徽章与去连接」要求——状态与 connection-center 的 `/api/connections` 同源、四态聚合、失败整体缺席、「去连接」深链到对应连接卡；「文案与质量线」场景更新为覆盖统一网格与徽章。

## Impact

- **前端**：`web/src/pages/AppCenterPage.tsx`（重写为单网格 + 统一 `AppCard`）、`web/src/lib/appCatalog.ts`（统一条目模型、产品归属、连接映射、徽章聚合纯函数）、`web/src/locales/{en,es,fr,ja,zh-CN}/common.json`
- **测试**：`scripts/test-app-center.mjs` 扩展（归属与排序、徽章四态聚合、映射 id 必须落在 `/api/connections` 的已知 id 集内、五语键齐）；`e2e/app-center.spec.js` 改写（统一网格 testid、徽章态、去连接深链落到连接分节）
- **后端**：不动
- **兼容**：testid `app-card-{id}`、`app-card-{id}-open`、`app-card-{id}-early-badge`、`app-card-yizuo-self` 保留；分区 testid `app-center-lines` / `app-center-platform-apps` 退役，改为单一 `app-center-grid`；`/apps` 路由与 `nav-apps` 不变
- **词汇表**：落实 CONTEXT.md「生态产品」词条的用户面
