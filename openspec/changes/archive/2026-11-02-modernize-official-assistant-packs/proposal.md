# modernize-official-assistant-packs

## Why

官方货架基线全扫（50 支）逮出第三批 12 支未达标包：助手型/套件型单岗包（六支柏讯套件、分身工坊、nano-pdf）persona 只有 230-350 字且无结构段；团队架构师与壹座产品介绍 skills=0；工厂集群两岗 306/315 字。前两批（starter 五支 + 业务团队十支）只覆盖了团队形态，这是收尾批——扫清后官方货架 50 支全部达标。

## What Changes

- **13 个岗位 persona 结构化深化**（≥380 字，【职责边界】【工作纪律】【输出契约】）：改版前文本逐字保留为前缀（生成脚本从快照拼接，零改写）；助手型岗位输出契约=答复契约（不硬套舰队 report_status），工厂集群两舰队岗保留 report_status。
- **共享岗跨包同文**：pack-wire-macro-analyst / pack-wire-valuation-analyst 同 id 同时在套件与投研三镜头两包，深化文本逐字节一致（生成脚本用同一常量）。
- **转正包红线**：nano-pdf 的技能正文是上游钉定快照（provenance e279b64），overlay 绝不带 skills，persona 深化不得改写技能步骤。
- **4 条新技能**：团队架构师（fleet-authoring-flow / fleet-edge-vocabulary）、壹座产品介绍（public-info-discipline / intro-triage-routing——只编码纪律不发明产品事实）。
- **部署侧缺陷修复（走查逮出）**：官方作者名册 OFFICIAL_AUTHOR_EMAILS 缺 aloadtree@finddatatech.cloud 与 platform-test@findmail.com——四支官方包（团队架构师/模拟交易套件/决策复盘套件/个股投研套件）在官方画廊隐身（个股投研套件自上线起不可见）；名册补齐后画廊 50/50。
- **发布身份**：四作者会话（aloadtree@gmail.com ×8、aloadtree@finddatatech.cloud ×2、platform-test@findmail.com ×1、publisher@finddatatech.cloud ×1）。

## Impact

- 12 支包同 id v+1，作者/编队/guide/分类零 diff。
- 新增静态门：`scripts/test-assistant-packs-content-baseline.mjs`（6 条断言，含共享岗同文与转正包零 skills）。
- 部署仓 fd-infra-deploy 名册一 env 值变更（83052dd，ArgoCD 恢复后自然收敛；已 kubectl set env 同值先行落地，零漂移）。
- 能力：`official-starter-agents-content`（ADDED 助手型基线 requirement）。
