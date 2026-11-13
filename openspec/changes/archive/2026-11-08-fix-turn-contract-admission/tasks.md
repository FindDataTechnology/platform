# Tasks — fix-turn-contract-admission

## 1. 执行侧再校验

- [x] 1.1 `fleet-runs.js` 账本新增 `admission(job)`：当前声明 → `assertTurnRequest`；
      非舰队/舰队已删 → `null`（不判）；并在返回对象上导出
- [x] 1.2 `cron-runner.js` 在账本 `begin` 之前调用；拒绝则本轮 `{ok:false, error:"turn contract refused: …"}`
      收口 + 落回合事件（与运行时就绪门同形）；未挂账本 degrade open

## 2. 测试（`scripts/test-turn-contract-admission.mjs`，4 条）

- [x] 2.1 `null` 不是拒绝：非舰队任务 / 空 job 均不判
- [x] 2.2 声明链内放行（5 内 depth 3）；声明收紧（2）后 depth 3 被拒
- [x] 2.3 默认声明（8）：depth 1/8 放行，9 被拒
- [x] 2.4 接线：超界回合以失败收口并落事件；合法回合照跑
- [x] 2.5 反证：删掉 runner 里的门 → 接线用例红；装回 4/4 绿
- [x] 2.6 邻接：27 个引用 cron-runner 的套件（约 300 条）全绿

## 3. 规格与文档

- [x] 3.1 `agent-turn-contract`：MODIFIED「契约取值受界」+ 2 个场景
- [x] 3.2 路线图：P2-7 第三项标为已修；P2-6「无取消 run」改正为「后端已有，缺 UI 入口」

## 4. 上线

- [x] 4.1 快照 91be7a2 → GHA image ✅ → relay OK → skopeo digest `sha256:70f5b449` → GitOps 3000513 →
      ArgoCD 对齐 → platform/facet 滚完 → **舱内跑本套件 4/4 绿**；现网镜像基线 c7181350c ⊂ 887734c91（不可回退）
- [x] 4.2 归档（`openspec validate --strict` 通过后）
