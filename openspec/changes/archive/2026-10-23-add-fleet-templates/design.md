# Design: add-fleet-templates

## 决策总览

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 模板载体 | pack 内嵌 fleet 段（manifest 扩展），走既有市场安装链 | 市场/安装/凭据/治理零改动；与「技能包内联 manifest」（ADR-0025）同构先例 |
| D2 | 预校验 | fleet 段进 `/api/packs/validate` 预校验（creator-pack 先例） | 非法清单（成环/坏 cron）在铸造端拦截，市场不上脏模板 |
| D3 | 启动安全 | 实例化完成=全队暂停+待确认启动 | 防止安装即烧钱；主人看一眼组织与节奏再开跑（成本护栏终局位） |
| D4 | 依赖缺位 | 逐项降级不整体失败 | 模板价值在结构；个别 a2a/连接器缺位不应废掉整支舰队 |
| D5 | 幂等锚 | 模板 packId+版本 → 舰队 sourceTemplate 字段唯一 | 重复安装/重装幂等；导出-重装链路可追溯 |
| D6 | 驾驶舱定位 | **单页合并**：驾驶舱即舰队页（/fleets/:id），管理动作（换防/暂停/调速/补岗）内嵌卡片菜单与抽屉；刀1 的树视图即驾驶舱骨架，刀4 只做呈现增强 | grill 裁决——「我的舰队」该是一个地方；两页=运维/创始人视角分裂给用户加负担 |
| D7 | 模板升级链 | v1 不迁移：新版只影响新实例化；现役提示「模板有新版」主人手动对齐 | 骨架-运行时合并是深坑（同 pack 升级是资源集重解析，舰队是运行时对象）；v2 再立项 |

- kpiSlots 支持 `target`（可选目标值）：驾驶舱槽值达标绿/未达标琥珀（grill 裁决进 v1）；趋势用刀2 系统比对值；cadence 为空=被动岗骨架（唯一岗校验同建岗）。

## 模板清单格式（pack manifest fleet 段）

```json
{ "fleet": {
    "nameKey": "tpl.company-fleet.name", "cover": "…",
    "members": [
      { "ref": "ceo", "titleKey": "…", "parentRef": null,
        "target": {"kind":"pack-preset","packId":"…","presetId":"…"},
        "kpiSlots":[{"key":"patrol_notes","labelKey":"…"}],
        "cadence":{"cron":"0 * * * *","tz":"Asia/Shanghai",
                   "promptTemplate":"巡视各部门…{{fleetContext}}"} },
      { "ref":"oss","parentRef":"ceo","target":{"kind":"pack-preset",…}, … }
    ],
    "requires": [{"kind":"a2a","name":"wanxing-cluster","optional":true}]
} }
```

- target 四类：`pack-preset`（安装包自带预设→建 persona）、`existing-persona`/`existing-cluster`/`existing-a2a`（引用用户既有对象，实例化时选择器兜底）。官方模板用 pack-preset 保一键性；引用型用于导出产物。
- 导出映射：现役 targetRef → existing-* 引用；报数/拍板/会话全剥；节奏与模板原样保留（含 {{fleetContext}}）。

## 实例化器（provisioner）编排

```
安装 pack →(既有链)→ 模板入库 → 主人打开模板确认页(选既有对象/确认节奏)
  → provisioner:
      1 查重(sourceTemplate+owner) → 已有则回报既有 id（幂等）
      2 逐岗解析 target: pack-preset→建 persona / existing-*→校验存在
        缺位岗 → 建岗但 vacant + 记缺位清单
      3 建舰队+岗位(全队 paused) → reconcile 物化(暂停态)
      4 落驾驶舱横幅「待启动」 → 主人点启动 → 批量 resume
```

- provisioner 是编排层：只调 catalog/clusters/fleets 既有 API，不直写他库——保持单写者纪律。

## 驾驶舱读面（/fleets/:id 单页，D6 合并裁决）

- 页面：舰队列表选入 → `/fleets/:id` 驾驶舱主视图；管理动作（换防含清史勾选/暂停/调速/补岗）全部内嵌卡片菜单与抽屉，不设独立运维页。
- 聚合端点 `GET /api/fleets/:id/cockpit`：树+latest 槽快照（含系统趋势与 target 达标态）+派生态+未决拍板（排序：severity→临近策略过期）+日报流（每岗一条 latest）+健康聚合。一次往返防四路拼装闪烁；各段字段直接复用前三刀的读面契约（无第二套语义）。
- 日报语义=报数史（无独立日报对象，grill 裁决）：日报流呈现各岗 latest，历史按日在时间线翻。
- 刷新：初次加载+既有 WS 广播通道增量（broadcastStatus/broadcastEvent 已有），不新造轮询。
- 失联岗置顶、临期拍板高亮、a2a「非自报」徽章沿用。

## 应用中心类目

- app-center 卡片加「舰队」kind（四态复用）；点击→模板确认页→provisioner。类目过滤沿用既有机制（app-center-unified-grid 先例）。

## 官方种子模板「公司式舰队」

- 岗位：CEO（巡视，{{fleetContext}} 模板）/ 开源部（GitHub 指标，fetch 面）/ 投资部（paper-trading 车道）/ 助理部（websearch 巡检）三真数据岗 + 电商部/内容部（连接器空态，待补岗示例）+ 萬星集群 a2a 成员（optional，缺位降级演示）。
- 该模板同时是机制的跨平台样板与 e2e 活体载体（四刀全链验收走它）。

## 风险与对策

- **pack 生态耦合**：fleet 段对老 pack 完全可选（无段=普通 pack，零影响）；校验器按段存在与否短路。
- **导出泄漏面**：导出器白名单字段制（只输出骨架字段），凭据/所有者/会话 id 不在白名单；e2e 断言导出产物 grep 无运行时痕迹。
- **确认页复杂度**：模板全部 pack-preset + 全 optional 依赖时确认页可一键直通（默认值全预填）——不让「一键」变成「十步」。
- **市场审核**：模板 prompt 是可执行内容，走既有 pack 上架审核面；fleet 段预校验是硬闸。

## 测试策略

- 模块级：清单校验（合法/成环/坏 cron/缺字段）、provisioner 幂等与逐项降级、导出白名单（运行时字段零出现）、启动前全队暂停语义。
- 活体级：市场真装官方模板 → 一键建队 → 确认启动 → 驾驶舱见 KPI 与日报流 → 拍板横幅闭环（承接刀3 验收）；导出→重装→骨架一致。
- 回归：无 fleet 段 pack 安装/校验零变化；app-center 既有类目卡片快照不变。
