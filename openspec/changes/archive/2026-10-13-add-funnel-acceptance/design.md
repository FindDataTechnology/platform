# Design — add-funnel-acceptance（F3.3）

## D1 五跳与取证

| 跳 | 动作 | 证据 |
|---|---|---|
| ① 自部署发布 | 本地 facet 实例（同版本代码，匿名读面）+ 真 vertical manifest（inline skill+serving 契约），经 createPackRegistry 落库=「发布在自己实例」 | 实例 detail 响应 |
| ② 官方上架 | F3.2 CLI `publish <id> --from <本地>`（静默续登复用 F3.2 配对设备）；**保持公开** | 官方 detail（author/visibility/manifest 逐字） |
| ③ 萬星部署 | 控制台真 UI（ego-browser）：目录见包→部署向导→绑 platformtest 自有 sub2api 键→deploy 200 | 向导响应+deployments 快照 |
| ④ 真金回合 | 外部调用者（**独立 sub2api 账号**的 key）`POST /a2a/<slug>` message/send，真 LLM 回合（flash 车道） | usage 台账行+扣款（settler=NULL、minutes>0） |
| ⑤ 分成落账 | trySettle 成功分支旁路→`wanxing_deployer_earnings` 一行（调用者≠部署者成立） | console/my/earnings + 账本行 |

## D2 身份拓扑（关键：分成条件=调用者≠部署者）

- **作者=部署者**：platform-test@findmail.com（creators 角色+F3.2 配对设备+console allowlist
  全就绪）。发布者自部署自包=漏斗的诚实叙事（MineView 文案的"你按分成获得收益"即此形状——
  分成是**部署者**收益账，ADR-0022；作者独立分成账不存在，案例卡如实写明）。
- **调用者**：独立 sub2api 账号的 sk- 键（≠platformtest 的部署键）；真金扣款走其余额。
- 部署键：platformtest 自有（绑定校验 ownership——键主须=部署者账号）。

## D3 pack 内容（真 vertical，非 hello-world）

单一主题小而可用：`市场快讯 · 一页速览`——一个 inline 技能（把一段财经新闻/公告收敛成
一页速览的固定工作法）+ 一个 serving agent（速览员 persona，a2a 契约+卡片示例）。
manifest 经 `validatePackManifest` 对拍（facet-pack-builder 律）。

## D4 明确不做

- 不改任何服务代码（除非验收暴露断链——届时最小修复+单独说明）。
- 不做作者分成账（ADR-0022 未设；案例卡诚实标注为边界而非承诺）。
- 不提现（闭环抵扣 v1 语义）。
