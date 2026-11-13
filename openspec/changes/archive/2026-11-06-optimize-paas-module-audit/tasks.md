# 任务：壹座模块体检

## 1. 总账与分簇

- [x] 1.1 267 条登记 ledger.md（十簇；实册比简报 253 多 14 条，以 ls 为准）
- [x] 1.2 分簇健康卡（G1–G9 / G8b / H7-1…5-6 / Ha / Hb，串行执行；G10 其余 32 条由 Hb 补位）

## 2. 集成

- [x] 2.1 评级回填（ledger 全 267 行有评级）+ 抽查（G1 cluster-core、G7 chat e2e、G5 ciyuan-intro、G9 cron 补跑四项实锤复核）
- [x] 2.2 backlog.md 已改为「第二遍增量对账版」：与归档单 2026-11-06-optimize-yizuo-module-audit 去重（第一遍条目复核态表 + 净新增 P0×1/P1×22/P2×10 + 已销账 S×5）+ 汇报

## 3. 战役内顺手修复（另立 change / 已单独提交）

- [x] 3.1 align-agent-delegation-spec-refs（已归档，paas 72947b040）
- [x] 3.2 agent-runner-b 滚 sha-ca6a7b4 + relay 同名 tag 缺口处置（fd-infra-deploy c144513）
- [x] 3.3 chat-turn 冒烟剥离清单跟上 UI（paas b3581402e）
