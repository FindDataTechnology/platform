## Why

F3 出口（`docs/facet-market-roadmap.md`）：F3.1 引导面板、F3.2 回流桥都已单点实证，
但「自部署者→官方市场→萬星→真金→分成」这条**漏斗全程**从未有一口气走通过的验收——
任何一跳断链，漏斗叙事就只是幻灯片。本片以一个真实垂直 pack 走完全程五跳，逐跳取证，
产出**案例卡**（journey + 证据 + 诚实边界），作为漏斗的活文档与回归基线。

## What Changes

- **五跳验收（生产真链，非彩排）**：
  ①自部署实例发布（本地 facet 实例 + 真 manifest 含 serving 契约）
  → ②官方市场上架（F3.2 CLI publish 桥，保持公开 listing）
  → ③萬星目录收录+部署（控制台真 UI：目录→部署向导→绑定部署者计费键）
  → ④真回合计费（外部调用者身份 ≠ 部署者，真 LLM 回合真金扣款）
  → ⑤分成落账（部署者收益账本+console 收益面）。
- **案例卡** `docs/ecosystem/selfhost-funnel-case.md`：五跳各自的命令/响应/账本证据、
  身份与键的拓扑（作者=部署者=platformtest；调用者=独立 sub2api 账号）、诚实边界
  （分成=部署者收益账非作者账，ADR-0022；闭环抵扣不提现）。
- 发现断链即修（验收的意义）；记录不修饰。

## Impact

- 文档为主+生产验收操作；若断链则带最小修复。specs：facet-platform 增补「漏斗案例
  卡=活文档」需求（walkthroughs 先例形状）。
- 不改计费/分成语义（ADR-0022 原样）；不改 registry/runner。
