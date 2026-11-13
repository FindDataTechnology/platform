# add-erp-miniapp-pagesets Tasks

> 契约来源：finddata 根 `add-supply-chain-vertical` tasks 6.1–6.6 + `fd-erp-vertical-templates/docs/miniapp-pagesets-handoff.md`。本单零后端契约实施（ERP 侧已立）；全程客户中性。
> 逐页验收总纲：manifest 清单对账（UE 12 / SE 10 / SP 8 / CP 8 = 38 页），每页 API 消费面与 `api-contract.md` 一一对应。

## 1. P0 — 底座抽取与装载机制

- [x] 1.1 `pageset-base/v1` 底座契约成文：按 design D1 复用点表抽取底座层（工程/登录绑定/runtime/Daylight/确认门），契约名落 `pageset-base/v1` 并回填 finddata 根四份 manifest `base.minBaseContract`——验证：底座面清单成文于本仓 docs（`docs/pageset-base-v1.md`）；回填 diff 点名四文件（四份 manifest 现行 base 段字段已一致且 minBaseContract 已为 pageset-base/v1，落名=现状成文，finddata 侧 0 diff）；paas 侧既有 7 页回归不受影响（tsc+biome+taro build+34 单测全绿）
- [x] 1.2 页面集装载与授权守卫：登录后经底座 REST 读租户授权组合（pagesetKey + requiredGrants），端内入口按授权渲染，未授权页面集端内不可见（不可见≠置灰）；页面路由守卫体验层拦截——验证：单测覆盖「无授权→入口不渲染→直入路由被拦」（`src/pagesets/pagesets.test.mjs` 10 例）；授权读面走 `src/lib/runtime.ts` 装配的 core http 传输无旁路（`src/pagesets/`：registry/authorize/store/guard，fail-closed）
- [x] 1.3 确认门通用组件：从 `src/pages/cron/index.tsx`（提交→`cron_added`/`cron_error` 回执→8 秒超时兜底）与 `src/components/QuestionCard.tsx`（`wsSend answer_question`）抽通用组件——验证：组件单测覆盖确认/拒绝回显/超时三路（`src/components/ConfirmGate/confirm-gate.test.mjs` 9 例）；cron 页改用组件后行为回归不变（文案/回执/staleness 守卫逐一保留；micro-diff：超时计时器不再因无关 store 变化重置，严格自提交起 8s）
- [x] 1.4 提审材料底稿：四端类目核对表 + 隐私声明增补清单（新增采集项列明）+ 演示沙箱方案（沿 `mp-demo-mode` 同构另立）——验证：底稿落 `paas/docs/erp-pagesets-submission-draft.md`，与 `docs/compliance-opening-assessment.md` §1.3 现状对账；挂账 Q-A/Q-B/Q-D 如实标注

## 2. P1 — ue-commerce（12 页）

- [x] 2.1 UE 框架页：`pages/ue/home`、`pages/ue/product-search`、`pages/ue/product-detail`、`pages/ue/cart`（manifest 域：商品检索/详情/进货单；API：`/erp/supply-chain/v1/ue/products*`、`cart*`）——验证：逐页按 manifest `apis` 字段对账（4/4 页 × apis 字段经 `ue-pages.test.mjs` 端点路径断言 + 本地 fd-erp-vertical-api 实态 curl 200）；样式过 Daylight 闭色板检查（app.css UE 段 hex 全在闭集；段外 8 处越板 hex 系既有存量，未触碰）
- [x] 2.2 UE 确认门页：`ue-order-create`（下单，信用不足拒绝附占用明细）、`ue-statement-confirm`（对账确认/异议）——验证：两页走 1.3 组件（useConfirmGate + ConfirmGate + 8s dispose 回归 cron 模式）；拒绝回显可解释（`creditExplain` 把 CREDIT_EXCEEDED detail 的 limit/ar_balance/reserved/available/requested_amount/shortfall 渲染成占用明细，单测断言逐字段）；超时不假报成功（真 ConfirmGate 机器三路：受理确认/拒绝回显/超时兜底，单测直驱）；确认回执如实 pending 不假报已确认
- [x] 2.3 UE 流程页：`ue-order-list`、`ue-order-detail`、`ue-invoice-apply`、`ue-aftersale-apply`、`ue-aftersale-detail`——验证：manifest 对账 12/12（registry ↔ app.config 静态注册 diff=0）；履约/轨迹读面与 api-contract §3 端点一致（fulfillment 404/handoff_pending/plans 三态如实）；开票×2 与售后×3 端点后端如实 501，页面渲染「该能力当前未提供」+ 服务器 message 原样，无假表单
- [x] 2.4 UE AI 页：`ue-ai-assistant`（入口先由底座 chat 面承载，独立页同源取数）——验证：取数通道与页面同一契约面（api-contract §7 无独立 AI 端点；页面唯一动作进入 `/pages/chat/index`；单测核验页面源无 ueApi/Taro.request/fetch/wsSend 任一调用，grep 无平行取数路径）

## 3. P2 — se-sales（10 页）+ sp-supplier（8 页）

- [x] 3.1 SE 框架页：`se-home`、`se-customer-list`、`se-customer-detail`、`se-lead-visit`、`se-order-track`、`se-statement-assist`——验证：manifest 对账 6/6（registry ↔ app.config 静态注册 diff=0，38 页全注册）；代客操作留痕业务员身份（`identity.ts` 解析 X-ERP-Staff = 会话账号或运行配置绑定，未绑定则 fail-closed 不发请求并显示绑定说明）；信用/对账数据 `credit_source`/`notes` 服务器人话原样呈现；`se-lead-visit` 后端 501 如实渲染 CapabilityUnavailable（不显示假表单）；`se-statement-assist` 推送 501 如实 + 「SE 端不可代拍板」铁律文案
- [x] 3.2 SE 确认门页：`se-order-proxy`（代客下单）、`se-alert-handle`（预警拍板）——验证：两页均消费 1.3 组件（useConfirmGate + ConfirmGate + 卸载 dispose）；`surfaces.test.mjs` 直驱真机器覆盖受理确认/拒绝原样回显（DATA_SCOPE_DENIED、CREDIT_EXCEEDED 附占用明细）/超时兜底三路；拍板回执如实（`alertReceipt`：confirmed 才说生效、rejected 明示留痕不落账；代客下单回执明示 pending=进确认车道、代理身份留痕）
- [x] 3.3 SE AI 页：`se-ai-assistant`——验证：同 2.4（源码级断言：代码行无 seApi/REST/wsSend 任一调用，唯一去向 `/pages/chat/index`；注释内纪律说明不计入）
- [x] 3.4 SP 全部 8 页：`sp-home`、`sp-order-accept`（确认门）、`sp-delivery-feedback`、`sp-arrival-notice`、`sp-reconciliation`（确认门）、`sp-invoice-upload`、`sp-payment-view`、`sp-ai-assistant`——验证：manifest 对账 8/8（registry ↔ config diff=0）；身份头 X-ERP-Supplier 未绑定即不发请求；接单/发货反馈/到货预告三页写面走确认门（拒绝必附原因端上先挡）；对账与发票后端 501 如实渲染且不显示确认按钮（金额未同源时确认门不存在）；`sp-payment-view` 明示资金红线（零支付操作面）；外部执行状态按 Q-B 现状如实（WMS 未定不伪装）

## 4. P3 — cp-carrier（8 页，含合规联动）

- [x] 4.1 CP 框架页：`cp-home`、`cp-dock-reserve`、`cp-track`——验证：manifest 对账 3/3；`cp-dock-reserve` 把两件事分清（可约时段目录 501 如实 / slotId 不透明引用的预约回执已实现，改约=再预约、取消须 reservationId）；`cp-track` 事件流+适配器轨迹同源，轨迹不可得如实置空不伪造节点
- [x] 4.2 CP 确认门页：`cp-waybill-accept`、`cp-reconciliation`（运费对账）——验证：`cp-waybill-accept` 消费 1.3 组件（拒绝必附原因、回执明示终态留痕与改派归属）；`cp-reconciliation` 后端 501 如实（不显示假运费单、不显示「可确认」按钮），计费口径单一出处文案在位
- [x] 4.3 CP 采集页：`cp-pickup-checkin`（作业码扫码复用 `bind-scan.ts`）、`cp-pod-report`（回单影像）——验证：两页均走 Taro.scanCode / 引用 id 双轨，**默认不采集定位、不读相册/相机**，页面明示「定位/影像为可选采集，须隐私声明过审后启用」（合规前置如实呈现，未伪装已启用）；采集项已列于 `docs/erp-pagesets-submission-draft.md` 隐私声明增补清单；扫码沿用底座同一 `scanCode` 实现
- [x] 4.4 CP AI 页：`cp-ai-assistant`——验证：同 2.4（源码级断言零取数，唯一去向 `/pages/chat/index`）

## 5. 合规收尾与凭证纪律（⑤）

- [ ] 5.1 提审提交：四端提审材料终稿（类目/隐私声明/演示账号与审核员路径）随首个提审窗提交——验证：材料留档；审核反馈回填本单
- [x] 5.2 移动端凭证三面验收：四端任一页面的抓包、本地存储、日志审计均无外部系统凭证字段；端上只持会话 PAT——验证：三面检查记录留档（交接材料 §三判据）；实测记录见 6.3 注记：请求头构造点仅 `Authorization`(会话 PAT) + `X-ERP-Staff/Supplier/Carrier`（源码级全量枚举，客户端全树无 appid/secret/证书/私钥字段）；本地存储键集封闭为 BASE/EMAIL/KEY/PRE_DEMO/SURFACE_BINDINGS/TOKEN 六类零凭证；服务端三包 print/logger 对 secret|password|api_key|private_key|token|credential|dsn|database_url 零命中，`config.py` 敏感字段全 `repr=False`
- [x] 5.3 挂账核对：Q-A 订阅模板（用户行动）、Q-B WMS 未定、Q-C 310 点回填、Q-D ICP 定性——逐项在 tasks 留痕状态，MUST NOT 伪装已通。**本项=状态核对，不代表四问已解**；逐条实证（2026-11-08）：
  - **Q-A 微信订阅消息模板：未办（用户行动，无进展）**。实证 `grep -rn "requestSubscribeMessage|subscribeMessage|tmplIds" miniapp/src` 零命中——端上根本没接订阅消息 API，所以「未办」不是文案口径而是代码事实：预警/单据通知目前没有任何触达通道，页面不宣称会推送。
  - **Q-B 锚点客户 WMS 品牌与接口形态：仍未定**。实证连接器目录 `open-connector-mt/src/providers` 1595 个 provider 中 `wms|warehouse` 匹配 **0**（WMS 无任何适配器），故 SP/CP 外部执行状态一律按现状呈现，SP 对账三端点与 CP 运费单保持后端 501 如实渲染，不摆假回执。
  - **Q-C 310 点逐条映射：未回填**。实证 `miniapp/src/pagesets/registry.ts` 中 `blueprint` 字段**0 处**——页面集 manifest 的 `blueprint` 段仍是功能域级（UE 7/SE 3/SP 4/CP 4 域），310 点清单资产化后才逐条回填；页面注册与授权判定不依赖该段，故不阻塞提审。
  - **Q-D ICP 定性：待公司侧定夺（未决）**。实证 `docs/compliance-opening-assessment.md` §1.2 原文仍为「需法务定性…**待公司侧定夺**」；提审材料按现行形态整理（域名备案已在，经营性许可未办），定性变化时增补。

## 6. 收尾

- [x] 6.1 `openspec validate add-erp-miniapp-pagesets --strict` 通过（含三个 spec delta）——验证：exit=0
- [x] 6.2 提交自查：paas 单仓点名文件提交（miniapp + openspec + docs），勿 `-A`（并行会话纪律）——验证：无并行会话文件卷入。**已提交 `2a486246d`（release/cell-session-persona，push gitee）**，113 文件/8592 插入：`miniapp/{package.json,tsconfig.json,src/app.css,src/app.config.ts,src/lib/auth.ts,src/pages/cron/index.tsx,src/components/ConfirmGate/confirm-gate.ts,src/pagesets/*,src/pages/{ue,se,sp,cp}/*}` + `openspec/changes/add-erp-miniapp-pagesets/*` + `docs/{pageset-base-v1.md,erp-pagesets-submission-draft.md}`；逐路径 `git add --`，提交前核过 `git diff --cached --name-only`（113 项全在本单范围）、密钥模式扫描零命中；**并发会话的 `pack-store.js`/`dsh-profile.js` 脏文件与另外 59 项他人在飞改动一律未卷入**。门：tsc 0 错 / `biome check src` 141 文件 0 / `test:unit` 74 passed。
