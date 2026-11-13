# Design: add-fleet-template-library

## Context

机制面（agent-fleet-templates：`server/fleet-template.js` 预校验、provisioner 实例化降级、市场舰队类目、导出）已全链在产，官方种子仅 `docs/fleet-templates/company-fleet.seed.json` 一份（已上架 `aofNf6o2LR61lPK8IVVkJw` v1）。本 change 纯内容面：新增四份种子 + 守恒测试 + 铸造上架，server/gateway 零改动，**无镜像出片**（仓内改动仅 docs/ 与 scripts/ 测试）。

## Goals / Non-Goals

**Goals**
- 四份新种子各自通过 fleet 段预校验并铸造上架（category=fleet），机制特性覆盖面互补。
- 守恒测试钉全库，种子腐烂即红。

**Non-Goals**
- 不动模板机制（预校验/provisioner/导出/驾驶舱/市场链）。
- 不为模板引入新工具面或新凭据形态；persona 只依赖既有 cell 能力，取不到数据如实报「未取得」。
- 不做模板内容运营面（封面/推荐位等）。

## 通讯原语约束（模板叙事必须围绕的运行时事实）

成员间**无自由 P2P 消息通道**，可用的只有三原语 + 一条横向通道：

1. **上行**：`report_status` 工具报数（append-only ≤8KB；频控=半个节奏周期、10 分钟下限、每窗 3 条）。
2. **下行**：`{{fleetContext}}` 注入——**只含直接下级**最新报数 + 舰队概况 + 拍板 digest（护栏 4KB/岗、24KB 总）。
3. **拍板**：`escalate` 上行（每岗每日默认 10 条、舰队 open ≤50），裁定经下一次节奏回合注入送达。
4. **横向**：delegation（`delegate_task` 委托 persona/a2a）是唯一的成员间协作通道；被动岗（cadence null）只能受委托或拍板批复唤醒。

推论：三层结构中中间层职责必须包含「向上浓缩」（{{fleetContext}} 只见直接下级）；岗位节奏错峰 ≥10 分钟（报数频控下限）；高频模板的 persona 必须教「同类事项合并为一条 escalate」（对抗每日防洪上限）。

## 硬约束

- **pack 自带 agents ≤3**：公司种子铸造实证的上限（种子因此把第 4 岗转为引用岗）。每份新模板自带 agents 恰 3，第 4 岗一律用 `existing-persona` 引用岗（`{{PLACEHOLDER}}` 占位）、被动岗或 `existing-cluster`/`existing-a2a` 表达。上限的确切代码位置未定位（疑市场/铸造侧），铸造前以公司种子同路径预演一份核实。
- **占位符补齐**：种子文件用 `{{PACK_ID}}`、`{{XXX_PERSONA}}` 等，铸造脚本补齐后上架；仓内文件是清单真源。
- **唯一岗规则**：persona/cluster 同时只能占一岗；引用岗占位符指向已占 persona 时走既有待补岗降级（已上产），模板无需特殊处理。

## Decisions

### D1. 四份模板与选型理由（代决，可换主题不改机制边界）

| 种子 | 骨架 | 自带 agents(≤3) | 第 4 岗形态 | 演示机制特性 |
|---|---|---|---|---|
| invest-morning 投研晨会 | chief→macro+sector，risk 挂 chief | 首席分析师/宏观研究员/行业研究员 | risk=existing-persona **被动岗** | 三层级联、被动岗拍板驱动、交易日节奏 |
| content-factory 内容工厂 | editor→planner→writer，reviewer 挂 editor | 主编/选题策划/撰稿人 | reviewer=existing-persona 被动岗 | 周流水线、被动岗**受委托唤醒**（横向协作唯一通道） |
| service-desk 客服护航 | lead→agent+qa | 客服组长/一线客服/质检员 | （恰 3 岗满编） | 高频节奏(每 4h)、escalate 合并纪律、CRM 工具面 |
| intel-brief 情报站 | chief→tech+market，cluster 挂 chief | 情报主编/科技情报员/市场情报员 | cluster=**existing-cluster** 引用岗 | cluster 引用岗（公司种子只演示了 a2a）、晨报流 |

选型依据：①能力面真实存在（模拟盘/paper-trading、文档工具、CRM 桥、web 搜索、集群）；②机制特性覆盖互补——公司种子已演示 {{fleetContext}} 注入/待补岗降级/a2a optional/cadence null，四份新种子补齐三层级联、两种被动岗唤醒路径、高频+escalate 合并、cluster 引用岗。

### D2. 节奏设计统一模式

- 时区一律 Asia/Shanghai；同舰队岗位错峰 ≥10 分钟（报数频控下限），沿公司种子 9:10/9:20/9:30 模式。
- 投研晨会：macro 09:00、sector 09:10（周一至五），chief 09:30 汇总（注入已含 09:00/09:10 报数）；risk 无节奏。
- 内容工厂：周一 09:00 选题会（editor）、10:00 立项（planner）、周二至四 10:00 撰稿（writer）；reviewer 无节奏。
- 客服护航：lead 每 4h 整点、agent :10、qa :30。
- 情报站：tech 07:30、market 07:40（每日），chief 08:00 晨报；cluster 岗周一 09:00 深度。

### D3. persona 文案纪律（承公司种子）

每份 persona：①岗位职责一句话；②点名用哪些既有工具取数；③**取不到数据如实报「未取得」，绝不编造**；④收尾必调 `report_status`（点名槽位 key）；⑤对上岗位教「超出权限用 escalate」（客服模板额外教合并上报）；⑥被动岗 persona 说明唤醒路径（受委托/拍板批复），不硬编码其他成员 id（运行时由主人/委托解析）。

### D4. KPI 槽设计

每岗 ≤4 槽（上限 8 留余量）；数值槽配 `unit`/`showDelta`，目标槽配 `target`（如客服首响 `target: 15` 分钟）；文本槽（要点/观点类）不配 delta。chief 岗统一带 `escalated`（待主人拍板数）沿用公司种子。

### D5. 守恒测试

`scripts/test-fleet-templates.mjs:465` 现钉公司种子单份——改为遍历 `docs/fleet-templates/*.seed.json`：①`parseFleetTemplate` 全过；②清单 `agents[].id` 与 fleet 段 pack-preset `presetId` 一一对应；③自带 agents ≤3。失败信息指明种子文件与校验错误（对应 delta 场景）。

### D6. 铸造上架

走 `aofNf6o2` 同一配方（台账 §15.13）：铸造脚本补占位符 → 上架 → curation category=fleet → 应用中心舰队类目眼见。四包依次铸造；先铸投研晨会一份全链预演（核实 agents 上限与舰队类目呈现），再批量铸其余三份。

## Risks / Trade-offs

- [agents≤3 上限来源未在代码定位，上限可能变化] → D6 预演腿先行；若上限不同，第 4 岗引用岗兜底模式不变，种子按实际上限收敛。
- [CRM 工具面凭据门控，未配置用户装了客服模板只能空转] → persona 纪律如实报；缺位不整体失败是既有 provisioner 语义。requires 不声明硬依赖（装模板不应被未装 CRM pack 拦住）。
- [被动岗依赖主人/委托主动性，可能长期沉默] → 驾驶舱被动标记既有；模板 description 说明唤醒预期；这是机制现状，不在本 change 扩展。
- [五卡类目的市场维护面] → 守恒测试钉住；再版以仓内真源为基准（delta 需求）。

## Migration Plan

无镜像滚版：仓内改动（种子 + 测试）随常规 CI；市场上架为生产操作（铸造配方见 D6），单包可独立回滚（registry 下架该 pack 版本）。

## Open Questions

- 种子封面 `cover` 字段是否配图、配什么图——上架呈现细节，可后决。
- 客服模板是否在 pack 描述里点名推荐先装 CRM 客服 pack（软引导文案）——文案细节，可后决。
