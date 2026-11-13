# Tasks: add-fleet-report-lane

## 1. 存储与工具

- [x] 1.1 fleets.db 增 member_reports 表（append-only，含 sessionId/slot 快照 JSON）+ latest 聚合查询，验证写入/时间线倒序/latest 正确性的单测
- [x] 1.2 report_status 工具注册（本地 MCP，沿 scheduling-tools 模式）：槽位校验宽容写入、summary 必填、频控（窗=周期/2 下限 10min、3 条/窗）与 8KB 体积上限，验证非成员拒绝/超频拒绝/未声明 key 回显的单测
- [x] 1.3 归属解析：preset→member、clusterId→member 两级解析与歧义拒绝，验证 persona/cluster 两类岗位归属 + 非成员 409 语义单测

## 2. 巡视注入

- [x] 2.1 cron.js 触发链插值器：sourceTag 命中且模板含 {{fleetContext}} 才渲染（否则逐字节短路），渲染内容=直接下级 latest 槽值+blockers+舰队概况+拍板摘要占位接口，验证非舰队任务 prompt 快照不变 + 命中任务注入含下级槽值
- [x] 2.2 渲染异常显性化：插值抛错时该次触发记失败并带结构化错误进 history，验证不静默空注入的单测
- [x] 2.3 截断护栏：4KB/岗、24KB 总量，验证超限截断与截断标记呈现

## 3. 读面与前端

- [x] 3.1 舰队详情 API 增 latestReport（含 source: self|derived、每槽系统趋势=对上一条同槽值比对、自报 delta 仅 note）与 reportTimeline 分页，验证时间线倒序、会话链接字段与趋势计算（含无前值=无趋势）
- [x] 3.2 a2a 岗位执行摘要生成：最近回合结果→摘要行，latest 视图 source=derived，验证标注「非自报」
- [x] 3.3 岗位卡 KPI 槽行（值+delta 着色）+ latest summary 行 + 详情抽屉时间线/来源会话跳转 + a2a 小徽章，stub 断言卡与抽屉渲染
- [x] 3.4 失联判定升级为双窗（执行超窗 ∨ 报数超窗）并携带命中窗说明，验证两窗各自触发与依据字段

## 4. 活体验收

- [x] 4.1 生产走查（2026-10-23 真轮次全闭环：电商岗真火 report_status→卡见 sales_week=309+self 摘要；换防后 latest at/slots 逐字连续；CEO 火会话注入逐字含「### 电商部 - 本周销售额（$）: 309…」；a2a 岗真火 latest source=derived 非自报）：persona 岗位真跑一轮报数卡片见值 → 换防后 latest 连续；CEO 岗位触发会话首条 prompt 含下级槽值（真 cell 会话取证）；a2a 岗位执行摘要标注呈现
- [ ] 4.2 回归：非舰队 cron 任务 prompt 逐字节不变快照 + 既有 scheduling-tools/工具面治理测试全绿
