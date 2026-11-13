## 1. 证据
- [x] 1.1 勘误 2026-10-19 ⑨b 5/5（park titler 空转绿）+ 记录 rc.2 三类回合请求事实（dsh-matrix README，d45c8e43）。
- [x] 1.2 dsh 0.2.1-rc.2 全量合同（--tree 干净安装）：8/17 → 不能跟，记录在案。
- [x] 1.3 真 cell 实验（生产 pod、真 provider、concurrent）：对称 8/8 + 非对称（收尾交错形状）6/6 + sanity，`notes/evidence.md` 存档。

## 2. 变更
- [x] 2.1 spec delta：启用条件改为「部署级运行时交错验证已记录」，代码默认仍 queue。
- [x] 2.2 `openspec validate flip-turn-dispatch-concurrent` 绿。

## 3. 上产与验收
- [x] 3.1 platform.yaml env：`TURN_DISPATCH=concurrent` + `DSH_MATRIX_CLOSE_INTERLEAVE=1`，推 gitee，ArgoCD refresh，rollout 绿。
- [x] 3.2 生产验收（真机、真实账号会话）：webhook 拉起用户 cell，双会话并发 prompt——两个 `agent_start` 重叠、双 `done`、无 `queued`、无 error；测试会话删除。确认 cell 日志无 `[turn-dispatch]` 降级告警。
- [x] 3.3 回滚面记录：`TURN_DISPATCH=queue` env 即回滚（无需镜像、分钟级；queue 全 UI 完整保留）。未在当夜生产演练——翻转前 24h 生产即 queue 态且完整验收过（concurrent-chat-sessions），两者互为演练。
- [x] 3.4 台账 §9 + 归档（sync 主 spec）。
