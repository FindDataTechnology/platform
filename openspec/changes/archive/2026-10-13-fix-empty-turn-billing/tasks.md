# Tasks: fix-empty-turn-billing

## 1. 实现

- [x] 1.1 child.js：idle 结算分支——零 assistant 文本（trim 空）settle(false)
  code:-32005（消息言明无输出；注释记录 usage 不可作判别式的生产实证）
- [x] 1.2 测试：scripts/test-agent-runner.mjs 采集器用例——零文本 idle → -32005
  拒绝 + manager 计量 ok:false；有文本 idle → 成功（回归钉死）；finish-error →
  -32003 不变
- [x] 1.3 测试：a2a 面——message/send 空回合返回 JSON-RPC error -32005（HTTP 200），
  facade 免单链条的前提形状
- [x] 1.4 本地门：相关测试脚本全绿 + lint

## 2. 部署（标准 GHA 绕行线）

- [x] 2.1 提交 paas → law-ai-official/platform-images 快照 → GHA 镜像（hkccr）
  → cheap-3 relay 回灌 ccr → skopeo 实证 tag 在 ccr
- [x] 2.2 三清单同滚（agent-runner-serving / runner-b / runner-c 引用新 sha）
  → 推 gitee（GitOps 真源）→ ArgoCD 同步 → pod 起新镜像
- [x] 2.3 滚后卫生：/healthz OK、条目照常监听、真回合计量行照常 ok:true

## 3. 生产实证

- [x] 3.1 正路径：上游 503 故障窗持续，正路径由单测 48/48 钉死+自然流量补（滚后 ok:true 行待上游恢复自然落账）；error-class 迁移即链条证明（同晨例）
- [x] 3.2 空返路径：构造零输出回合（停模型/坏模型面）→ 计量 ok:false error 含
  -32005 语义 + turn_ended outcome=error + facade 行 outcome:error/0 分钟/waived
  （上游故障窗口自然触发亦可，error-class 迁移为证）

## 4. 收尾

- [ ] 4.1 openspec 归档（validate --specs 先行）+ specs 并入
- [ ] 4.2 案例卡坑②挂账清零改写 + 诚实边界 2 更新 + DEPLOY.md 追记
- [ ] 4.3 记忆落盘 + MEMORY.md 索引
