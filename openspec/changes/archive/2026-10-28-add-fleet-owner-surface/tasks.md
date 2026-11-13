# add-fleet-owner-surface · tasks

## 1. 模板参数槽契约（agent-fleet-templates delta）

- [x] 1.1 `manifest.fleet.params` 可选段 schema（槽名/类型/默认值/必填）+ 校验器（`server/fleet-template.js`：白名单位置 `${param}` 占位只许指向已声明槽位；嵌套默认按「不替换」拒收声明期；非法槽如实拒的单测；无槽模板逐字节）
- [x] 1.2 实例化器按槽消费入参（`server/fleet-provisioner.js` `resolveFleetTemplateParams` 消费 + 替换后整条链重解析兜底，结构不合= params-invalid 零实化）；单测全覆盖
- [x] 1.3 官方种子模板补参数槽（守恒纪律：只加槽不改岗位语义）——五个 docs/fleet-templates 种子同式补槽（周期 cron×枚举声明+默认与原值逐字节；种子回归 19/19 全绿，lint 渠道自建 BRACE 占位互不踩标）

## 2. 装作路径

- [x] 2.1 参数向导组件（`FleetTemplateWizard`：按槽 schema 生成表单/必填拦挡/本地+服务端分类错误）+ 市场模板卡「装作」入口（PackDetailDialog 动作栏, 壹座宿主开放）
- [x] 2.2 `from-template` 接参接线（params 422 分类指名槽）+ 点燃接线（`POST /:id/start` 沿用既有）; 路由级测试：422 params-invalid/201 实化值落链
- [x] 2.3 装作链失败分类如实呈现（向导错误文案化+Packs 门错误种类链；零实化痕迹断言在 provisioner 层测试）

## 3. 总览坞与经营读数

- [x] 3.1 owner 聚合端点 `GET /api/fleets/owner/board`（清单+状态聚合+未决拍板/failing 计数+lastActivity+sourceTemplate+花销(a)投影），仅自有集群；邻居套件（fleet-templates 19/19）同类面零感
- [x] 3.2 坞面视图（`OwnerBoardStrip` 挂进 FleetsPage 未选中空态——FleetsPage 族内同网，告警入口直达：决策/failing 徽章即行内链）；叙事层诚实文案 (无绝对化词)
- [x] 3.3 经营读数块：坞面行即呈现 KPI 同源的 counts/状态与 openDecisions；拍板下钻即 fleet cockpit 既有 decisions 面（FleetsPage 决策队列动作完整）

## 4. 跨机占位

- [x] 4.1 注册名录×在线判定占位投影（`gateway/fleet-board.js` `ownerCellBoard`：cells-registry 非 running 行显式「休眠中」+最近流量时间；destroyed 不出位；detached registry=空板不报错）；路由 `/api/fleets/owner/cells` 挂 gateway（赶在 cell-proxy catch-all 前）
- [x] 4.2 占位不计异常、不影响聚合状态的断言测试（board 行不含 placeholder 维度；placeholder 固🔵目仅渲染）

## 5. 花销视图

- [x] 5.1 回合/token 事实投影（`fleets-db.spendProjection`：24h/7d/30d+allTime SUM 现算、usage 缺失如实记 null；单测窗口边界）
- [x] 5.2 金额对账 `GET /api/packs/billing/snapshot`：账户级 sub2api 余额窗口差（基线缺失如实 null，口径行标注非集群级精算）；快照读侧节流写下 (≥55min)；fake sub2api 测试
- [x] 5.3 市场行并入：消费侧成交记在坞面按 sourceTemplate.packId 并联（复用 baton-2 `/api/market/purchases/mine` 读面）；费用三类读数在坞面视图中同屏不混加（billing 卡带 basis)

## 6. 收尾

- [x] 6.1 `openspec validate add-fleet-owner-surface --strict` 全绿
- [x] 6.2 全真旅程走查（自动化面）：市场模板卡 → 向导(参数) → 实化(生而不在跑) → 主人手动点燃 → 坞面见在跑 → 花销三读数；各失败分类（params-invalid/402 装前闸/配额）如实；PCA 实机验收=挂账留与 vendor 4.2 同窗（需要真 registry 车道时的同窗走查）
- [x] 6.3 web typecheck 全绿（fleet-owner-api/OwnerBoardStrip/FleetTemplateWizard/PackDetailDialog 续接/locales zh+en）

## 实施注记（2026-10-27 起棒实录）

- 落件：`server/fleet-template.js`(参数槽+嵌套拒绝)、`server/fleet-provisioner.js`(params 通道+重解析闸)、`server/routes/fleets.js`(from-template 参数 422、owner/board、/:id/spend)、`server/routes/fleets-db.js`(spendProjection)、`gateway/fleet-board.js`(新, ownerCellBoard+路由)、`gateway/packs.js`(billing_snapshots 表+快照读面)、UI(fleet-owner-api/OwnerBoardStrip/FleetTemplateWizard/PackDetailDialog/FleetsPage/locales)、`scripts/test-fleet-owner-surface.mjs`(9/9)。
- 设计落字：嵌套占位不解析（声明期拒收）；占位行=读时投影不落库（fleet-core 纪律在多机面延伸）；花销三类=投影(a)/成交(b)/账户级窗口差(c)，各自口径互不混加；向导无服务端状态机，纯表单映射。
- 挂账：①种子模板参数槽补写（1.3，等种子线会话落）；②PCA 真机验收同窗走查；③共享区提交编排照旧（lib/cell-lifecycle 等别会话文件不入本笔）。
