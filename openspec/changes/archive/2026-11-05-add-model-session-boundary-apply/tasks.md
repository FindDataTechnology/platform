## 1. identity 拆分（manager.js）

- [x] 1.1 `#identityOf` 摘出 `model` 字段（组合身份余十一字段）；reconcile identity pass 行为不变（model 单独变更不再触发 drain）。验证：既有 manager 测试全绿；新增「仅模型变更不排干」用例。

## 2. 热更新路径（manager + harness adapter）

- [x] 2.1 `DshHarnessAdapter` 增 `updateMemberModel(agentKey, {provider, model})`：更新成员停车图（solo 单成员同构），不触碰 `#prepared` 与在途 collector；非法输入拒绝。验证：adapter 单测（pod 成员级+solo 级）。
- [x] 2.2 `manager.reconcile` 增模型对账段：per-key 比较 descriptor `effective_model` 与运行时记录，不同则调 `updateMemberModel`；每轮幂等收敛。验证：reconcile 循环两次后模型图稳定（幂等断言）。

## 3. 语义测试（新会话新模型/在途旧模型）

- [x] 3.1 会话边界语义：模型热切后新会话以新模型创建（`preset/set`+`model/set` 停车序列断言），变更时已在途的会话保持旧模型直至结束。验证：新增测试全绿。
- [x] 3.2 pod 隔离：pod 内单成员热切，兄弟成员 `#prepared` 与在途 collector 零扰动。验证：新增测试全绿。
- [x] 3.3 混合变更：模型+persona 同批变更 → 一次排水重生且新组合带新模型物化（无二次中断）。验证：新增测试全绿。
- [x] 3.4 车道授权回归：热切只接受写时已授权车道（descriptor 携带的即已授权面），配置面校验语义零变化。验证：既有写时校验测试全绿。

## 4. ADR 修订与收口

- [x] 4.1 `docs/adr/0019` 追加 2026-11-05 修订注记（不重写历史）：模型变更改会话边界热切；「不引入第三种重启通道」约束改写为「进程级重启通道仍只有排水重生一种，会话边界热切非重启通道」。验证：ADR 文本在案。
- [x] 4.2 全套件回归：agent-runner 既有测试 + persona 孪生 + 新增用例全绿；`openspec validate --strict` 过。验证：命令输出全绿。
- [x] 4.3 出片上产（沿 platform 通道，快照显式 `--ref`、bump 前内容验尸）+ 生产实证：真部署改模型后新会话新模型/在途旧模型眼见为实。验证：GitOps commit + imageID 双证 + 实证记录。→ **2026-11-05 收尾（协同窗口分工：代码+池快照由外部窗口完成，relay 等待+bump+ArgoCD 由本窗口收尾）**：GitOps `d27128f` 双清单 bump sha-a9669b2→sha-b28b45d，digest 9dab25e8 hkccr/ccr 双仓全等，ArgoCD hard → 双 pod imageID 全等，in-pod 符号实证（updateMemberModel=2/inflightWakes=4——P1/P2 双机制同 pod 在产）。**fd-verify-image-content 首次实战**：bump 前内容验尸（updateMemberModel 6+2/inflightWakes 4）。生产实证（真部署改模型眼见为实）**2026-11-05 16:5x 补齐闭环**（探针 pack pod-cohost-probe/analyst @ agent-runner-c，分片已在产 sha-b0275ea 热切符号 grep 复核）：预热回合跑通（flash）→ registry 翻 effective_model=mimo-v2.6-flash → runner 日志 `model hot-swapped to mimo-v2.6-flash (session boundary…)` 落线、零 `descriptor changed; draining`、child 存活 → 新会话落盘 transcript 明文 request/header `"model":"mimo-v2.6-flash"`（对照翻前会话 `"model":"deepseek-v4.1-flash"`，zstd 落盘双证）→ registry unset 回滚 → 第二条 hot-swap 线回 flash、复原会话 transcript 复核 flash、writer 兄弟零扰动（无家目录=从未被触碰）；另证出片链细节：首推快照 3b2be27 抓出 fd-build-snapshot 标签（本地树 sha）-内容（origin clone sha）对账不一致（并发班次 docs 提交未推即 diverge），按 harden-snapshot-pipeline 纪律随批推齐后重出 b28b45d 一致快照；分片滚版 1ef7a3a（serving+c）先行落热切代码，随后被并行班次超集批次 1cad815 sha-b0275ea 覆盖滚动。
