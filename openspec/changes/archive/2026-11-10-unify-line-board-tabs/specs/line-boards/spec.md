## MODIFIED Requirements

### Requirement: 每条已接入产品线有一块线看板

壹座 SHALL 为每条已接入的**外部**产品线提供一块线看板，路由为 `/boards/:line`。已接入的四条线 SHALL 覆盖谦面（facet）、萬星（wanxing）、柏讯（wire）与识律（lex）。壹座（base）是宿主自身而非外部产品线，MUST NOT 提供 `/boards/base` 看板；对该地址的请求按未知 line 处理，且降级文案 SHALL 说明「本线由宿主自身承载」而非「尚未接入」。未知或未接入的 line SHALL 渲染诚实降级（说明该线尚未接入并提供原站链接），MUST NOT 渲染空看板或伪造数据。

#### Scenario: 打开谦面看板

- **WHEN** 用户访问 `/boards/facet`
- **THEN** 渲染谦面看板，含该线标题、原站链接与至少一个数据块

#### Scenario: 打开识律看板

- **WHEN** 用户访问 `/boards/lex`
- **THEN** 渲染识律看板，四块分属概览、我的凭据、套件、账单四个页签

#### Scenario: 未知 line

- **WHEN** 用户访问 `/boards/unknown-line`
- **THEN** 页面显示该线尚未接入并提供原站链接，不渲染任何数据块

#### Scenario: 宿主线不设看板

- **WHEN** 用户访问 `/boards/base`
- **THEN** 页面说明壹座是宿主自身、不设线看板，并给出继续使用的入口，不渲染任何数据块

## ADDED Requirements

### Requirement: 页签集合由适配器声明派生，前端不得落后

一条线的页签集合 SHALL 等于该线适配器返回的块所声明 `tab` 值的去重集合，且顺序由适配器声明顺序决定。前端 MUST NOT 维护第二份手写的页签表作为事实来源；契约测试 SHALL 双向比对「前端渲染出的页签」与「适配器声明的页签集合」，任一侧多出或缺少一项即失败并点名单侧多出的那项。

#### Scenario: 识律四块各有页签

- **WHEN** 打开 `/boards/lex` 且适配器返回概览、我的凭据、套件、账单四块
- **THEN** 页面渲染四个页签，每个页签只显示属于它的块

#### Scenario: 适配器新增页签而前端未跟进即失败

- **WHEN** 某线适配器新增一个带新 `tab` 值的块，而前端页签表未更新
- **THEN** 契约测试失败并点出该线缺少的页签名

#### Scenario: 前端多出空页签即失败

- **WHEN** 前端页签表声明了一个该线适配器从未声明的页签
- **THEN** 契约测试失败并点出该空页签名，而不是线上渲染一个永远为空的页签

#### Scenario: 只有一块的线不渲染页签条

- **WHEN** 一条线只有一个页签（全部块同属一个 `tab`）
- **THEN** 页面直接渲染该块，不渲染单页签的页签条

### Requirement: 整线未接入上游时一次说清

当一条线返回的**全部**块都带 `under_construction` 哨兵时，页面 SHALL 渲染一个整线状态（线标题、建设中说明、原站深链），MUST NOT 渲染页签条，也 MUST NOT 为每个块重复同一句说明。

#### Scenario: 萬星整线建设中

- **WHEN** 用户打开 `/boards/wanxing` 且该线三块全部为 `under_construction`
- **THEN** 页面只显示一处建设中说明与原站链接，不出现页签条，不出现「集群概况：建设中 / 任务：建设中 / 部署：建设中」三行重复

#### Scenario: 部分块建设中仍按页签呈现

- **WHEN** 一条线的部分块有真实数据、部分块为 `under_construction`
- **THEN** 页签条照常渲染，建设中块在其所属页签内单独降级，不影响其它块
