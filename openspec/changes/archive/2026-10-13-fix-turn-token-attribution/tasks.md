# Tasks: fix-turn-token-attribution

## 1. 实现

- [x] 1.1 manager.js tokensOf：总数命名优先 + harness 分列（inputTokens/input_tokens +
  outputTokens/output_tokens）求和回退；两不匹配维持 null
- [x] 1.2 fakeHarnessClient assistant/message 事件补挂 dsh 真实形状 usage；计量测试
  断言 tokens=150；无 usage 变体断言仍 null
- [x] 1.3 本地门：test-agent-runner 全绿 + lint（改动文件零新增告警）

## 2. 部署（标准 law-ai 快照线）

- [x] 2.1 提交 paas → 快照推 law-ai → GHA → relay 回灌 → ccr manifest 实证
- [x] 2.2 三清单同滚（serving/b/c）→ gitee+github 双推 → ArgoCD → pod 起新镜像
- [x] 2.3 滚后卫生：/health OK、条目照常、计量流照常

## 3. 生产实证

- [x] 3.1 上游恢复窗口实证 ✓：滚后首回合 RESULT 成（429 字回复）+计量行 ok:true tokens:428（700/700 恒 null→真数值；turn_ended 同函数同修）；board 三 runner 在册 roster 8

## 4. 收尾

- [x] 4.1 openspec 归档（validate --specs 先行）
- [x] 4.2 记忆落盘 + MEMORY.md 索引
- [x] 4.3 cheap-1 退役容器 agent-runner-dsh-retired-20261013 + 卷清理（新 runner
  稳定性已确认：接管后三镜像滚、计费/分成链复核、无回滚需求）
