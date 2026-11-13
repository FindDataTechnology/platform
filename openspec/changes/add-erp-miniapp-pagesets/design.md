# Design: add-erp-miniapp-pagesets

> 契约来源：finddata 根 `add-supply-chain-vertical` tasks 6.1–6.6；交接材料 `/Users/chengsishi/finddata/fd-erp-vertical-templates/docs/miniapp-pagesets-handoff.md`（2026-11-07 核验）。本单只做 paas 侧端上实施与底座复用，后端契约不在本单。

## D1 底座抽取与 pageset-base/v1 落名

四份 manifest 的 `base` 段已实地核对 paas 现状，逐项有据：

| 复用点 | 证据路径（现状实地核验） |
|---|---|
| Taro 4.2.1 + React 18.3 工程 | `paas/miniapp/package.json`（`@platform/miniapp`，@tarojs/* 4.2.1 全家桶，react 18.3，`@platform/core: file:../packages/core`） |
| 页面注册（现 7 页） | `paas/miniapp/src/app.config.ts`（chat/login/bind-guide/share/cron/resources/command，custom 导航 + 胶囊让位） |
| 运行时层（token/WS/REST） | `paas/miniapp/src/lib/runtime.ts`、`src/lib/taro-http.ts`、`src/lib/taro-socket.ts`；WS/REST 契约与 web 共享 `packages/core` |
| 扫码绑定登录 | `paas/miniapp/src/lib/bind-scan.ts`（Taro.scanCode 封装，取消不视为失败）、`src/lib/bind-qr.ts`；页面 `src/pages/login/`、`src/pages/bind-guide/`；承接 spec `mp-bind-guide`/`miniprogram-auth`/`device-pairing-auth` |
| Daylight 设计系统 | `paas/miniapp/DESIGN.md`（"The Daylight Pocket"：纸面底/白卡/唯一 Pocket Blue/闭色板/88rpx 触达；`src/app.css` 单文件普通 CSS、字面 hex） |
| 确认门模式 | `paas/miniapp/src/pages/cron/index.tsx:155-181`（提交后表单保持打开，等服务器 `cron_added` 确认或 `cron_error` 拒绝回显，8 秒超时兜底「服务器未确认，请检查连接后重试」）；`src/components/QuestionCard.tsx`（`wsSend answer_question`，多端先答先得） |
| chat = AI 入口 | `paas/miniapp/src/pages/chat/index`（底座主面，`@platform/core` store，流式/历史/附件） |
| 提审合规经验 | `openspec/specs/mp-demo-sandbox`、`mp-demo-mode`（审核员无账号演示沙箱）、`miniprogram-auth`（openid/unionid 数据纪律）；`docs/compliance-opening-assessment.md` §1.3（MP 侧历轮提审有隐私声明，web 端无） |
| 消息订阅 | `docs/yizuo-platform-roadmap.md` Y3 第二片（微信订阅消息触达，模板申请=用户行动项，已挂账） |

抽取纪律：**底座层是既有代码的成文与组件化，不是重写**。`pageset-base/v1` 契约内容 = manifest `base` 段声明的最低面（框架版本 + 三复用页 + 四 lib + Daylight），落名后回填 finddata 根 manifest（交接核对清单 #1）。底座自身演进仍按 paas openspec 根治理，契约声明最低兼容面、不锁死 patch 版本（manifest `baseNote` 原文）。

## D2 装载机制：页面级 pack，与 vertical-packs 不同构的裁定

- **裁定**：ERP 页面集是「页面级」pack（manifest 声明 pages 清单 + 页面级 requiredGrants），与既有 `vertical-packs`（skill+MCP+agent 组合 pack）**不同构，不强行复用其装载实现**；复用的是**授权语义**（未授权不可见）与 pack 元数据纪律（id/version/specTrace）。
- 装载读面：登录后经底座 REST 读租户授权的页面集组合（pagesetKey ∈ `supply-chain.ue|se|sp|cp`），端内据此决定哪些页面入口可见；页面本身随包编译（小程序不支持运行时动态页面注册），「未授权不可见」落在**入口与路由守卫**层，而非动态装载代码。
- 页面命名空间：`pages/<surface>/<page-id 去前缀>`（如 `pages/ue/home`、`pages/cp/pickup-checkin`），在 `src/app.config.ts` 按端分组追加，与现有 7 页并存。
- 授权对位：`requiredGrants`（如 `order.write.proxy`、`statement.confirm`）接 paas 权限面（spec `role-system`、`auth`）；服务端逐页校验为准（api-contract 通用约定），端上守卫只做体验层隐藏。

## D3 确认门组件化

- 以 `cron/index.tsx` 的四段式为模式源、`QuestionCard.tsx` 为组件同构参照，抽 `ConfirmGate`（暂名）通用组件：提交→pending（禁重复提交+「创建中…」态）→ 服务器确认（成功态）/ 拒绝回显（服务端可解释 message，如信用占用明细）→ 8 秒超时兜底文案。
- 席位语义：移动端 confirm/reject = 账本内核 proposal 面的 confirm/reject 席位（与 owner 席位同源），**不是**平行审批通道；经 `wsSend` 走底座 WS 通道，不另开 WS 面（api-contract 通用约定原文）。
- 超时/失败 MUST NOT 假报成功：超时回显沿用 cron 页文案纪律；拒绝必须可解释（沿 `mp-demo-sandbox` 的 machine-readable code + 人话 message 纪律）。
- CP 端提货打卡的作业码扫码复用 `bind-scan.ts` 同一扫码实现（cp-carrier api-contract §4）。

## D4 四套页面集分期与验收

| 期 | 内容 | 页数（confirmGate） |
|---|---|---|
| P0 | 底座抽取 + `pageset-base/v1` 落名回填 + 装载/授权守卫 + 确认门组件 + 提审材料底稿 | 0 新页 |
| P1 | `ue-commerce`（订货台，最重：下单/对账双确认门 + 取价 + 售后） | 12（2） |
| P2 | `se-sales` + `sp-supplier`（业务员代客/预警拍板；供应商接单/对账承接 UE 订单下行） | 10+8（2+2） |
| P3 | `cp-carrier`（承运商/司机，含定位/影像可选采集 → 合规联动过审后再上） | 8（2） |
| 收尾 | AI 入口深化 + 提审提交与合规三面验收留档 | — |

- 逐页验收判据：manifest 每页的 `id/title/covers/apis` 对账落勾（38/38），每页 API 消费面与其 `api-contract.md` 端点一一对应，无契约外旁路请求。
- AI 入口（`*-ai-assistant` 4 页）：P1 起先以底座 chat 面承载（入口在 pageset 首页），`*-ai-assistant` 独立页随各自期落地，与 chat 面同源取数。
- 分期理由：UE 是锚点客户功能域最全集且驱动 SP 下行数据；CP 的采集项有合规前置，故置后。

## D5 合规与移动端凭证纪律

- 提审材料：沿底座历轮提审经验（roadmap「0.6.x 提审多轮」）；类目按四端业务形态核对；隐私声明增补新增采集项（定位/影像），**过审后再上**对应采集页能力；演示沙箱按 `mp-demo-mode` 同构另立，不得把生产 ERP 数据暴露给审核路径。
- 移动端凭证纪律（交接材料 §三）：端上只持会话 PAT（底座既有），不持任何外部系统凭证；凭证只进连接器凭证面（萬星 custom_credential）；三面验收 = 抓包 / 本地存储 / 日志审计均无外部系统凭证字段（redact 纪律对齐连接器 secret redact）。

## Open Questions（挂账，如实）

- **Q-A 微信订阅消息模板申请**：用户行动项（roadmap Y3 已挂账），页面集预警/单据通知触达依赖它，MUST NOT 伪装已通。
- **Q-B 锚点客户 WMS 品牌与接口形态未定**：影响 SP/CP「外部执行状态回流」展示细节，契约面不受影响（交接材料挂账 #2）。
- **Q-C 310 点逐条映射回填**：功能域级已落账（UE 7 域/SE 3 域/SP 4 域/CP 4 域），310 点清单资产化后回填 manifest `blueprint` 段（交接材料挂账 #1）。
- **Q-D ICP 证定性**：`docs/compliance-opening-assessment.md` §1.2 待公司侧定夺，本单提审材料按现行形态整理，定性变化时增补。
