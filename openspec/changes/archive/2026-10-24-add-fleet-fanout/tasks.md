# Tasks: add-fleet-fanout

## 1. 校验(纯函数)

- [x] 1.1 `validateOrchestration` 增 fanout 分支:targets(≥2/无重复/全存在/from∉targets/tool 拒)、aggregate 形状(judge 引用规则/a2a-judge 拒)、rounds 1–3;DAG 检测不变(仍只 handoff);span 出度计 targets;验证:校验矩阵单测(五拒+默认形状两过)
- [x] 1.2 spec delta 实施期修正:rounds 语义按 design D2 收敛为「声明性上界,硬界=depth」——同步 delta 场景三措辞(depth 界拒绝),openspec validate 绿

## 2. 运行期(收口缝)

- [x] 2.1 `triggerFleetHandoffs` 扩 fanout 出边:每目标 manual 任务(depth+1/wave 记 origin/initiator 两式接线:judge 合成键+initiatorPreset、无 judge 用上游会话);brief 上游 ok/failed 转述+轮次标注;验证:注入 executor 断言任务组形状与 initiator 两式
- [x] 2.2 验证点三连(design D4):聚合器注入回合不过缝(实证)、合成 initiator session 自建、handoff/fanout 同上游并存零互扰;验证:以 fake 聚合断言组语义(或注明以既有 aggregator 测试覆盖)

## 3. 测试与回归

- [x] 3.1 `test-fleet-orchestration.mjs` 补 fanout 用例全绿(1.x/2.x)
- [x] 3.2 十三套回归零新增红;`openspec validate add-fleet-fanout` 通过
- [x] 3.3 出片随攒车列车 + 真机验收(fanout 两目标并行波→judge 裁决回合注入)+ 台账补记
