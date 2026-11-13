## 1. 实现

- [x] 1.1 lib/agent-serving.js：`modelChoiceError` 加 `roster` 参数（null=未知开放；非包含即拒+附在册清单）
- [x] 1.2 agent-runner/fleet.js：sampler 加 roster 缓存+后台刷新（provider 默认 buildLlmProfile 派生，失败省略字段；同步注入供测试）；runner_stats 负载带 `models`
- [x] 1.3 gateway/packs.js 部署路由：车道验证后加 roster 门（安置 runner ?? 默认行；board.runners[id].models 非数组跳过；400 MODEL_NOT_IN_ROSTER）

## 2. 测试

- [x] 2.1 test-fleet-report.mjs：sampler 携带 models（同步 provider 注入断言首 tick 即带）；provider 失败省略字段
- [x] 2.2 modelChoiceError roster 分支单测（在册过/不在册拒+清单/未知开放）
- [x] 2.3 部署路由回归（test-deploy-lock harness 扩展或新文件）：board 带 roster 拒不在册（400 MODEL_NOT_IN_ROSTER+清单）；board 不可达→照常部署；既有用例不回归

## 3. 部署与生产验证

- [x] 3.1 出片（判梯：org→scs001→law-ai-official/platform-images 绕行）→ ccr 实证 → GitOps 四面滚（platform/facet/runner-serving/runner-b/runner-c）
- [x] 3.2 生产三证：board 三 runner 各 8 项花名册（心跳 ≤40s 落板）；lane 门先行实证（nex-n2→MODEL_LANE_REJECTED）；**F3.3 事故原模型 inclusionai/ling-3.1-flash → 400 MODEL_NOT_IN_ROSTER+在册清单**；deepseek-v4.1-flash 照常部署 200
- [x] 3.3 滚后观察：runner-serving/b/c 心跳健康、既有部署零影响

## 4. 收尾

- [x] 4.1 F3.3 案例卡挂账①翻案（剩余=空回合采集器识别，挂账②余项）
- [x] 4.2 openspec 归档 + 记忆
