# Proposal: add-erp-miniapp-pagesets

## Why

ERP 线的四套小程序页面集契约已在 finddata 根成文（`add-supply-chain-vertical` tasks 6.1–6.6；交接材料 `/Users/chengsishi/finddata/fd-erp-vertical-templates/docs/miniapp-pagesets-handoff.md`），且四套 manifest 的 `base` 段均以**壹座 miniapp 底座**为宿主声明（`base.minBaseContract = pageset-base/v1`，Taro 4.2.1 + React 18.3 + Daylight 设计系统）。底座侧现状零对应实施：`paas/miniapp/src/app.config.ts` 仅注册 7 页（chat / login / bind-guide / share / cron / resources / command），无页面集装载与「按租户授权组合启用、未授权不可见」机制。本单把「契约 → 端上实施」立项：底座复用 + 确认门组件化 + 四套页面集分期落地 + AI 助手入口 + 提审合规延伸。

**边界（重要）**：页面集消费的后端 REST/WS 服务（`/erp/supply-chain/v1/*`）在 ERP 侧实施（finddata 根 change 已立，契约本体在各 pack `api-contract.md`）；paas 侧只做端上实施与底座复用，不改后端契约。全程客户中性（无具体客户名，统称「锚点客户」）。

## What Changes

- **① 页面集宿主机制**：从 `paas/miniapp` 抽出可复用底座层（Taro4 工程 + 扫码绑定登录 + 消息面 + Daylight token + 确认门），落名 `pageset-base/v1` 兼容契约并回填 finddata 侧 manifest；新增页面集装载机制——按租户授权组合（`pagesetKey` + 页面级 `requiredGrants`）动态出页面，**未授权页面集端内不可见**（不可见≠置灰）。页面注册在 `src/app.config.ts` 按端分组追加（建议命名空间 `pages/<surface>/...`）。ERP 页面集是「页面级」pack，与既有 `vertical-packs`（skill+MCP+agent 组合）**不同构**，本单裁定复用面并成文。
- **② 确认门交互组件化**：把底座既有「提交→服务器确认→拒绝回显→超时兜底」模式（`src/pages/cron/index.tsx` 的 pending 态 + `cron_added`/`cron_error` 回执 + 8 秒超时兜底；`src/components/QuestionCard.tsx` 的 `wsSend answer_question` 同构）抽为通用确认门组件。四端全部 confirmGate 页面（UE 下单/对账、SE 代客下单/预警拍板、SP 接单/对账、CP 接单/运费对账，共 8 页）复用；移动端拍板 = confirm/reject 席位（与 owner 席位同源经账本内核 proposal 面），超时/失败 MUST NOT 假报成功。
- **③ 四套页面集分期实施**：按各 manifest 页面清单逐页落地，共 **38 页**（UE 12 / SE 10 / SP 8 / CP 8）；全部网络面经 `src/lib/runtime.ts`/`taro-http.ts`/`taro-socket.ts`，禁止旁路直连；样式按 `miniapp/DESIGN.md`（Daylight，闭色板纪律）。分期与逐页验收判据见 design/tasks。
- **④ AI 助手入口**：底座 chat 面（`src/pages/chat/index`）为 AI 入口主面，接 ERP fleet 提供经营问答/推荐/预警处置；manifest 各端 `*-ai-assistant` 页与 chat 面同源取数（同页同后端契约），MUST NOT 建平行取数路径；AI 动作类输出必须经确认门（②的组件）。
- **⑤ 合规延伸**：提审材料更新——四端类目核对、隐私声明增补（新增采集项如定位/影像须列明并过审后再上）、演示/沙箱路径沿 `mp-demo-sandbox`/`mp-demo-mode` 同构另立（不把生产 ERP 数据暴露给审核路径）；移动端凭证纪律——BYOK 凭证零落库在移动端的三面验收（抓包/本地存储/日志均无外部系统凭证，端上只持会话 PAT）。

## Capabilities

### New Capabilities

- `erp-pageset-hosting`：页面集宿主契约——底座抽取 `pageset-base/v1` 落名、按租户授权组合装载与不可见语义、底座复用边界（禁第二套框架/设计系统/旁路网络层）、AI 助手入口同源取数。
- `erp-confirm-gate-mobile`：确认门移动端组件化契约——「提交→服务器确认→拒绝回显→超时兜底」四段式为唯一拍板交互；confirm/reject 席位同源生效；失败/超时不假报成功。
- `erp-pageset-compliance`：页面集合规契约——提审材料与隐私声明随页面集更新；移动端 BYOK 凭证零落库三面验收；演示沙箱同构另立。

### Modified Capabilities

（无——底座既有 spec（`miniprogram-client`、`mp-bind-guide`、`mp-command-center` 等）行为不变；本单全部为新增能力。）

## Impact

- **paas/miniapp**：`src/app.config.ts`（页面注册扩展）、`src/pages/<ue|se|sp|cp>/...`（38 新页）、`src/components/`（确认门通用组件）、`src/lib/`（页面集装载/授权读面，经 runtime 层）。
- **不触碰**：后端 REST/WS 契约实施（ERP 侧）、`packages/core` 共享契约的破坏性变更（页面集只新增消费面）、底座既有 7 页行为。
- **跨仓回填**：`pageset-base/v1` 落名后回填 finddata 根四份 manifest 的 `base.minBaseContract`（交接核对清单 #1）。
- **用户行动项（挂账，非本单可闭环）**：微信订阅消息模板申请、锚点客户 WMS 品牌未定（影响 SP/CP 外部执行状态回流展示细节，契约面不受影响）、310 点清单资产化后回填 manifest `blueprint` 段。
- **验证**：`openspec validate add-erp-miniapp-pagesets --strict` 通过；逐页验收按 manifest 清单对账（38/38）；确认门组件单测覆盖确认/拒绝/超时三路；合规三面验收（抓包/存储/日志）记录留档。
