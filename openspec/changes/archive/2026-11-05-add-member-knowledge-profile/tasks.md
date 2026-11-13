# Tasks: add-member-knowledge-profile

## 0. 前置

- [x] 0.1 add-agent-memory-foundation 已上产（metadata/结构化筛选/oversight/platform 代铸 deployment 可用）
- [x] 0.2 生产存量 `f/<fleetId>` 页回填已跑（地基单回填命令），回填报告留存

## 1. deployment 令牌铸造与缓存

- [x] 1.1 cell-memory.js 扩展：platform token 经 /admin/mint 代铸 deployment 令牌（`d/<packId>/<memberId>`），缓存 `cell-memory-tokens/d-<packId>-<memberId>.json`（0600、重启稳定、换防不换）
- [x] 1.2 降级开：铸造失败计数重试，物化与回合不阻塞；platform 令牌自身绝不进成员运行时上下文
- [x] 1.3 单测：铸造+缓存命中、重启稳定、失败降级、换防令牌不变

## 2. capture 分流

- [x] 2.1 fleet-memory.js：五类事实按 D2 映射分流（turn/health→own，decision-*/swap→shared），metadata 承载 fleetId/memberId/kind（一等 metadata，标题去前缀编码）
- [x] 2.2 `f/<fleetId>` 停止新写；存量页零改写
- [x] 2.3 幂等键 `(fleetId, memberId, kind, ts)` 语义保留；零 LLM、fire-and-forget、fail-open 不变
- [x] 2.4 单测：分流落位、metadata 检索、重放幂等、capture 失败不污染回合

## 3. knowledge profile 设置面

- [x] 3.1 蓝图 schema 增 knowledge 段（memory 开关/scope/注入预算/文档集引用），校验、试跑、diff 三链识别；悬空/越权集合校验期拒绝
- [x] 3.2 管理面部署级覆盖读写（留痕）；effective profile 纯函数（D3）单测覆盖
- [x] 3.3 缺省 profile = 文档化默认（memory on、own+shared、现行默认预算、无文档集）；存量蓝图物化行为与文档一致
- [x] 3.4 单测：默认等价、覆盖生效、非法段拒绝、diff 语义化展示

## 4. 挂载参数化（seam 单点）

- [x] 4.1 mcp 配置生成处按 member 参数化 fd-memory 行（deployment 令牌）+ 文档边界参数（profile 集合）
- [x] 4.2 供给门补边界断言；多路径回归断言（cron/手动唤醒/房间召唤三路径 patch 一致）
- [x] 4.3 profile.memory=off 成员：无 fd-memory 行、无记忆段（不留占位）
- [x] 4.4 spike（open question）：万星 console 侧部署成员 lane 是否同吃挂载，结论记 design.md

## 5. 文档集运行时绑定

- [x] 5.1 部署设置增删成员文档集即时生效（下回合可见）；library 工具过滤链消费 profile 集合（本项目 ∪ 集合 ∪ shared）
- [x] 5.2 越界 read_document 报「不存在」；文档本体不进记忆真源
- [x] 5.3 单测：增删即时生效、越界拒绝、移除集合后不可见

## 6. 注入合流与统一预算

- [x] 6.1 fleetContext 记忆段 = own（按本成员结构化筛选）∪ shared ∪ 存量 f/（D5 过渡），复用 chat-memory digest 契约（硬预算/层标注/排除纪律）
- [x] 6.2 统一预算梯子：记忆（own→shared→f/ 顺序）→ 文档命中，逐档截断标注，不挤掉下级报数段
- [x] 6.3 不可达/缺席时段缺席（显式降级）；预算计入 fleetContext 总量上限
- [x] 6.4 单测：合流与标注、梯子截断、缺席降级、总量约束

## 7. 经验沉淀纪律

- [x] 7.1 memory-discipline.js（单一来源）增经验沉淀段：读文档要点 → memory_write_page 落 own 分区、带文档出处；「文档要点≠记忆」纪律入文
- [x] 7.2 双面（fleet runner + chat cell）共用同一字符串零漂移；单测断言两处 import 同源

## 8. 收口验证

- [x] 8.1 全量测试绿零回归；新增用例全过
- [x] 8.2 真机冒烟：物化三成员团队 → 铸令牌 → 回合 capture 分流 → fleetContext 合流注入 → 运行时增删文档集 → oversight 下 owner 可读成员分区
- [x] 8.3 清理 src/ 内部 IP/秘密；`openspec validate add-member-knowledge-profile --strict` 绿后归档
