# erp-pageset-hosting Spec

## Purpose

ERP 四套页面集（supply-chain.ue/se/sp/cp）在壹座 miniapp 底座上的宿主契约：底座抽取为 `pageset-base/v1` 可复用层，页面集按租户授权组合装载且未授权端内不可见，全部网络面与取数同源（复用底座运行时与 chat AI 入口），禁止第二套前端框架/设计系统/旁路通道。契约本体在 finddata 根（`add-supply-chain-vertical`），本 spec 只约束 paas 侧端上实施。

## ADDED Requirements

### Requirement: 底座复用边界

ERP 页面集 SHALL 复用壹座 miniapp 底座：同一 Taro 工程（`paas/miniapp/package.json`，Taro 4.2.1 + React 18.3）、同一扫码绑定登录（`src/lib/bind-scan.ts`，页面 `src/pages/login/`、`src/pages/bind-guide/`）、同一运行时层（`src/lib/runtime.ts`/`taro-http.ts`/`taro-socket.ts`）、同一 Daylight 设计系统（`paas/miniapp/DESIGN.md`，闭色板纪律）、同一 WS 通道。页面集 MUST NOT 另起前端框架、第二套色板/卡片体系或旁路网络直连；底座兼容面 SHALL 以 `pageset-base/v1` 契约成文（内容=manifest `base` 段声明的最低面），落名后回填 finddata 根 manifest。

#### Scenario: 页面集网络面全部走底座运行时

- **WHEN** 对四套页面集的全部页面代码做网络调用检查
- **THEN** 所有 REST/WS 请求经 `src/lib/runtime.ts`/`taro-http.ts`/`taro-socket.ts` 封装，无绕过底座层的直连

#### Scenario: 底座兼容面成文且回填

- **WHEN** 底座抽取完成并落名 `pageset-base/v1`
- **THEN** finddata 根四份 manifest 的 `base.minBaseContract` 回填该契约名，底座最低面（框架版本/复用页/复用 lib/Daylight）与 manifest `base` 段声明一致

#### Scenario: 样式过闭色板检查

- **WHEN** 任一页面集页面的样式进入评审
- **THEN** 所用颜色/字号/圆角均在 `paas/miniapp/DESIGN.md` 既有 token 集合内（`src/app.css` 字面 hex 闭集），无新引入 hex

### Requirement: 按租户授权组合装载且未授权不可见

页面集 SHALL 按租户授权组合启用：端内在登录后经底座 REST 读取租户被授权的页面集（pagesetKey ∈ `supply-chain.ue|se|sp|cp`）与页面级 requiredGrants，入口据此渲染；未授权页面集 SHALL 端内不可见（不可见≠置灰），直入其路由 SHALL 被守卫拦截；服务端逐页权限校验 SHALL 为准（端上守卫为体验层）。页面集装载 SHALL 成文为「页面级 pack」并与既有 `vertical-packs`（skill+MCP+agent 组合）的不同构裁定一并落档。

#### Scenario: 未授权页面集对租户完全不可见

- **WHEN** 一租户未被授权某页面集（如 `supply-chain.cp`）而登录 miniapp
- **THEN** 端内无该页面集任何入口渲染，直接访问其页面路径被守卫拦截并给出可解释提示

#### Scenario: 授权组合变更后可见性跟随

- **WHEN** 租户被追加授权一个页面集后重新登录
- **THEN** 该页面集入口出现，其页面所需 requiredGrants 由服务端逐页校验

### Requirement: AI 助手入口与页面同源取数

AI 助手入口 SHALL 以底座 chat 面（`src/pages/chat/index`）为主面接 ERP fleet（经营问答/推荐/预警处置）；manifest 各端 `*-ai-assistant` 页与 chat 面 SHALL 同源取数（同一后端契约与 fleet 通道），MUST NOT 建平行取数路径；AI 动作类输出 MUST 经确认门组件（见 erp-confirm-gate-mobile）后方可生效。

#### Scenario: AI 问答与页面取数同源

- **WHEN** 用户在 AI 助手入口询问某订单/对账单状态
- **THEN** 返回数据的取数通道与对应页面消费的 `/erp/supply-chain/v1/*` 契约同源，无第二套数据路径

#### Scenario: AI 动作输出经确认门

- **WHEN** AI 助手给出需要执行的动作类输出（如代客下单建议）
- **THEN** 执行前必须经确认门组件的用户拍板，不接受 AI 直接落单
