# Tasks: add-fleet-template-library

## 1. 种子清单（docs/fleet-templates/）

- [x] 1.1 投研晨会舰队 `invest-morning-fleet.seed.json`：3 自带 agents（首席分析师/宏观研究员/行业研究员）+ risk 引用岗被动岗（existing-persona `{{RISK_PERSONA}}`）；节奏 macro 09:00 / sector 09:10（周一至五）/ chief 09:30；chief prompt 含 {{fleetContext}} 汇总与 escalate 纪律、persona 含「取不到如实报」；KPI 槽按 design D4。验证：`parseFleetTemplate` 通过 + agents 与 presetId 一一对应
- [x] 1.2 内容工厂舰队 `content-factory-fleet.seed.json`：3 自带 agents（主编/选题策划/撰稿人）+ reviewer 引用岗被动岗；周流水线节奏（editor 周一 09:00 / planner 周一 10:00 / writer 周二至四 10:00）；reviewer persona 写明受委托唤醒路径。验证：同 1.1
- [x] 1.3 客服护航舰队 `service-desk-fleet.seed.json`：恰 3 岗满编（组长/一线客服/质检员）；高频节奏 lead `0 */4 * * *` / agent `10 */4 * * *` / qa `30 */4 * * *`；persona 教「同类疑难合并为一条 escalate」；首响槽带 target。验证：同 1.1
- [x] 1.4 情报站舰队 `intel-brief-fleet.seed.json`：3 自带 agents（情报主编/科技情报员/市场情报员）+ cluster 引用岗（existing-cluster `{{INTEL_CLUSTER}}`，周一 09:00 深度）；晨报节奏 tech 07:30 / market 07:40 / chief 08:00。验证：同 1.1

## 2. 守恒测试

- [x] 2.1 `scripts/test-fleet-templates.mjs` 守恒测试扩全库：遍历 `docs/fleet-templates/*.seed.json` 断言每份过 `parseFleetTemplate`、`agents[].id` 与 pack-preset `presetId` 一一对应、自带 agents ≤3；失败信息含种子文件名与校验错误。验证：`node --test scripts/test-fleet-templates.mjs` 绿 + 人为改坏一份种子（成环）测试红且指明文件，随后还原（**首跑即抓真分歧：公司种子自带 4 agents 超上限、与已上架 aofNf6o2（助理转引用岗）不一致——已把公司种子收敛为 3 agents+助理 existing-persona 引用岗，真源对齐上架现实，对应 delta 场景三**）
- [x] 2.2 回归：既有公司种子单份钉与 fleet-templates 其余单测不回归。验证：全文件测试跑绿（templates 10/10 + fleet 族 55/55）

## 3. 铸造上架（生产操作，走 aofNf6o2 配方·台账 §15.13）

- [x] 3.1 预演腿：铸造投研晨会一份（补 `{{PACK_ID}}` 等占位符 → 上架 → curation category=fleet），核实 agents≤3 上限与舰队类目呈现。验证：市场列表眼见 + 详情 fleet 段在 + `/api/packs/validate` 同源预校验绿（2026-10-23：`YMSt-hRNiNWXrlLYC8PSiA` v1 上架，category=fleet，agents=3 无拒绝，本地 validatePackManifest+parseFleetTemplate 先绿；`{{PACK_ID}}`→`self`、RISK→facet-assistant 沿公司包同款替换；上限真身=lib/pack-manifest.js:40 maxAgents:3）
- [x] 3.2 批量腿：其余三份依次铸造上架同配方。验证：舰队类目 5 卡（公司+四新）眼见（tkHe8IHE0BuDYYIg5LglUw 内容工厂 / EMGW14N8voa1b36LSuTxxw 客服护航 / 56opYgliV9FYAmhmsDIJOw 情报站）
- [x] 3.3 上架一致性核对：每份所上 pack 的 fleet 段与仓内种子文件语义一致（占位符补齐除外），对应 delta 场景。验证：逐包 diff 核对记录在台账（四包 SEMANTIC MATCH：种子+占位符补齐+category 即上架 manifest，逐字零差异）

## 4. 活体验收（aloadtree 真会话）

- [x] 4.1 全链走查（投研晨会）：市场装 → from-template 201（missing=[] conflicts=[]，facet-assistant 空闲故风控被动岗直接活体）→ 确认启动 → 驾驶舱 3 物化岗 on_duty+被动岗 → 首个节奏回合报数上卡 + chief 巡视注入含下级报数。验证：cockpit 读面证据（岗态/任务/卡槽）（2026-10-23：装 200 三 agents → 201 fleet_…4iuzp0 出生全暂停 → start 200 on_duty 3+passive 1；**报数/注入用 run-now 原生火实证**（POST /api/cron/:id/run）——宏观卡 macro_view=滞胀交易真数据（布油 113.5/美10Y 4.95%/央行逆回购 2580 亿）+行业卡 sector_pick=白酒+1.68%/茅台 600519；chief 火产出晨会要点**点名四矛盾跨两下级报数原文**（茅台 20.4x vs 宏观宽松已打满）+缺口如实标注（风控未报数/持仓未取得）+escalated=1；拍板项为真综合（引两下级报数+时间戳 11:39/12:20）；choice 批准 build_defensive→execute-now→**delivered**；注入渲染不落盘=历史存原始 {{fleetContext}} 属上刀设计，证据取 chief 产出）
- [x] 4.2 安装腿（其余三份）：各至少「装→实例化→确认启动」走通（含客服模板 CRM 未配置时岗位如实空转、情报站 cluster 缺位时待补岗降级）。验证：from-template 响应 + 缺位/冲突清单符合预期 + 测试舰队清理（内容工厂 201+missing[reviewer]→审校 vacant、客服护航 201 满编 3 岗 on_duty、情报站 201+missing[cluster]→集群深度席 vacant——cluster 缺位降级按预期精确落位；三舰队验收后解散 archived，投研保留为低耗观察载体（工作日 3 回合/日））
- [x] 4.3 被动岗唤醒实证（内容工厂 reviewer 或投研 risk 任一）：受委托或拍板批复唤醒一次。验证：唤醒回合产生的报数/任务记录（**唤醒已实证**：owner 侧 one-shot 派发（POST /api/cron）给风控官 persona=facet-assistant，真回合真产出（6 条风控提示+成果库 risk-review-2026-10-23.md+复核已批策略）；**报数腿撞出真生产 bug 并已本地修**——归岗候选集不过滤 archived 舰队（server/routes/fleets.js 报数/escalate 两处），§15.14 swap 进已解散舰队的幽灵岗与活岗撞歧义 409，修=候选集跳过 archived+test-fleet-report-lane 幽灵岗测试钉住（突变验证红/绿），**待出片后生产复验补报数**；另发现聚焦模式人格无 delegate_task——受委托唤醒在聚焦面走不通，缺口挂 v2）

## 5. 收尾

- [x] 5.1 台账 `docs/registry-maintenance.md` 补记（四 pack id/版本、上架证据、活体验收记录）（§15.15：四包表+守恒测试+活体全链+两真 bug+走查事故披露）
- [x] 5.2 `openspec validate add-fleet-template-library` 绿 + 归档流程（apply 完结后）（validate 绿；出片 sha-94bb331/digest f71dc49d 三面滚完（**首滚 2d99a05 为陈树快照事故重演**——fd-build-snapshot 标签读本地 sha、树从 origin clone，当时 origin 停在 3e7e9a5f 未含修复；重出前先核快照树含 Ghost-post guard×2 再出片）；生产复验=one-shot 绑定 preset 派发 facet-assistant→report_status→**风控岗 risk_flags=6 上卡**（归岗唯一命中）；另第三次发现=UI 追问 cron 会话不重绑原 preset、以当值人格跑（记台账）；归档随本勾账）
