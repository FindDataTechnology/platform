## Why

壹座的编排面已经长出三套机制（fleet 舰队岗位、orchestration 编导边、cluster 小队），pack 也能声明 `fleet` 模板段——但模板只搬岗位不搬编导，bot 又被挡在 pack 之外（只能当活舰队编排里的事件源），"装包即得一支会协作的混合舰队"还差最后一块。同时谦面市场已积累 69 个 pack，出现三类重复：同名建重（柏讯·预期差/政策传导/信息冲击各有 v1+v2 两个 packId）、同域双线（数据-X 与柏讯·X套件每域两份）、CRM 三份（市场两包+内置种子），目录里还混着验收/演示包。需要一次整体收口：舰队模板补全 + 市场去重治理。

## What Changes

**A. 混合舰队模板补全**

- pack `fleet` 模板段新增 `orchestration` 声明（mode/constraints/edges：trigger/dispatch/handoff/fanout，含 `bot:<id>` 事件源边）——发布预校验复用活舰队的 validateOrchestration，provisioner 把编导边落到实例化的活舰队，导出器 round-trip 带回。
- **bot 成为 pack 第三原语**（与 skills/MCP 引用同级）：manifest 新增 `bots[]` 段；平台托管"通用 bot"（通道适配器 telegram/feishu/wecom/wechat-oa + 简单功能 bot），pack 可引用通用 bot 或声明"通用 bot + 挂一个 pack 内技能"的轻量 bot 单元，用来处理简单功能（定位类似一个 MCP/skill 的可复用单元）。
- 舰队模板成员 target kinds 补齐：新增 `bot`（引用 pack bot 或 cell 已有 bot，缺失→岗位空缺待补，沿用 provisioner 冲突降级哲学）与 `tool`（对齐活舰队已有的 tool 岗位，消除模板/实例能力不对称）。
- 官方舰队种子升级为带编导的完整模板（内容工厂=周流水线 dispatch 链；客服护航=bot 入站唤醒→dispatch）。

**B. 谦面市场去重与目录治理**

- 发布闸防呆：同作者同名 pack 发布 → 拒绝并提示以既有 packId 升版（杜绝"重发不带 packId 建重"再次发生）。
- 清理既有重复（运营动作，走 facet 管理 API）：3 对同名建重（v1 下架，v2 为准）；数据域六包（数据-股票估值/区域经济/行业企业/宏观分析 v3、数据-股票 v3、数据-中国经济 v4）收编进柏讯对应套件（柏讯线为单一事实源，柏讯套件缺的技能并版补齐后原包下架）；CRM 两市场包合一，内置 `packs/crm-desk-suite` 保留为铸造源、市场为唯一分发更新通道。
- 目录治理：验收/演示包（向导验收·双子、一键流验收、部署演示·FingPt 分析师）转 unlisted；存量 pack 的 category 补齐（fleet/daas/legal/crm/facet/docs 既有惯例）。

**裁决记录（用户 2026-10-25）**：A+B 合一个 change；数据相关 pack 由柏讯线承接（数据并入柏讯）；bot 定位=skills 等简单形式的 pack 单元，需抽象通用 bot 处理简单功能。

**假设（可再裁决）**：数据-指标工坊/数据-自助分析/数据研究·生态版/市场快讯属产品工具面而非域内容，不在收编之列、保留原样；法律样例包（法律-合同/法律-案件）与识律六套件的同域重叠本次不动（用户未裁决）。

## Capabilities

### New Capabilities

- `pack-bot-units`: bot 作为 pack 第三原语——manifest.bots 声明形状、通用 bot 清单与引用规则、发布预校验、安装物化（绑定/待补状态）、与舰队 bot 成员的衔接。

### Modified Capabilities

- `agent-fleet-templates`: 模板段新增 orchestration 声明与 tool/bot 成员 target kinds；官方种子必须带编导；provisioner/exporter 对新字段的往返。
- `agent-fleet-orchestration`: 编导边可随 pack 模板下发；模板下发边的校验时机与 bot 事件源存在性判定。
- `pack-marketplace`: 发布同名防呆闸；重复/演示内容的 unlist 与 category 治理维护面。
- `vertical-packs`: 数据域样例包退场（收编进柏讯线），样例面仅保留法律两包。

## Impact

- **paas 仓代码**：`lib/pack-manifest.js`（bots 段校验）、`server/fleet-template.js`（orchestration/tool/bot 解析）、`server/fleet-provisioner.js`（编导落地+bot/tool 目标解析）、`server/fleet-orchestration.js`（模板边校验复用）、`server/routes/fleets.js`（实例化携带编导）、`server/routes/packs.js`/`pack-store.js`（bot 条目安装）、`server/bots.js` 与 `server/bots/adapter.js`（通用 bot 只读面）、`facet/`（发布闸同名检查）、`docs/fleet-templates/*.seed.json`（种子升级）。
- **生产运营**：facet 市场（facet.finddatatech.cloud）清理动作走管理 API（下架/并版/category 补齐），需出片与灰度。
- **finddata 仓（工具面，仅脚本）**：发布脚本沿用 `--pack-id` 纪律；防呆落在网关侧为治本，finddata 侧脚本不改也不影响正确性。
- **兼容性**：无 fleet/bots 段的 pack 行为逐字节不变（既有"缺段即普通 pack"短路路径保持）；活舰队新增 bot/tool 成员对旧部署为可忽略的新枚举值，属新增而非破坏。
