# add-cluster-digest-injection

## Why

接续评测首跑 PASS（2026-10-25，台账 §15.30：digest−none 重推导度分差 1.75/胜率 75%、首步分差 0.75/胜+平 83%）打开了记忆架构 v4 的门，digest 注入块（`src/digest.ts` + `hybridCandidates`）已被证明有效。生产第一落点选集群回合：S0 实证其现状只注入**标题目录**（hook ① 的 `- title（date）` top-5）、cluster cell 有真实 pull 行为但弱（read_page ~30 次）、u-aloadtree 交接认领率仅 8%——这条管线全部现成（person 令牌、/pages 面、degrade-open、集群记忆开关），是风险最小的生产落地，也是 digest 原型从评测到生产的第一段验证（两段验证纪律的田野侧）。

## What Changes

- **fd-memory 平台缝 digest 读面**：`GET /digest?project=<name>&k=&budget=`——服务端经生产候选检索（`hybridCandidates`，向量优先关键词兜底、fd-memory→sidecar embed 查询进程内现成链路）取 top-k，`src/digest.ts` 渲染（预算硬顶、forget/expired 排除、open handoffs 通知段）返回 `{digest, items, truncated}`。**渲染单源在服务侧**，paas 不复刻格式。
- **paas 集群 hook ① digest 化**：`cron-runner` 集群回合的共享记忆注入从标题列表升级为 digest 块（一次渲染全员注入，queryFor=回合任务 prompt）；**降级阶梯**：digest 面失败 → 回退现有 /pages 标题列表 → 再失败 → 无块任务照常（degrade-open 不变量不动）。
- **参数与开关**：k=5 / budget=1500 默认（评测所用值），`CELL_MEMORY_DIGEST_K/BUDGET` env 覆盖；`CELL_MEMORY_ENABLED=0` 关闭时与现状字节等同。
- **网格定默认值**（接走 add-continuation-eval 任务 5.2）：apply 期对真实 endpoint 跑 k∈{3,5}×预算∈{800,1500} digest 臂 4 组，终值回填本 change。
- **明确不做**：壹座 chat 开场注入（S5）、萬星 spawn 注入（v4 本体）、u/ 根蒸馏触发（S4' 独立微 change）、MCP 面暴露 digest 工具（agent 侧注入线随 v4）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `fleet-memory`：平台缝新增 digest 读面（person 令牌自己 root + platform/runner 带 rootKey 车道；agent 令牌拒；线协议不携 root 名）。
- `memory-federation`：cell 集群回合的两挂点之一（注入挂点）升级——digest 块 + 三档降级阶梯；写回挂点与组合/凭据纪律不变。

## Impact

- **fd-memory**：`http.ts` 平台缝路由 + digest 组装（检索复用 `hybridCandidates`、渲染复用 `src/digest.ts`，~60 行）；单测 +权限矩阵/预算/排除（~4 测）。
- **paas**：`server/cluster-memory.js` 增 `readDigest`（5s 超时）；`server/cron-runner.js` hook ① 切换 + 降级阶梯（~30 行）；单测三档降级 + 开关归零（现有 cluster-memory 测试扩展）。
- **出片**：双端同车（fd-memory + platform，标准 TCR 线；fd-build-channel 判路）。
- **风险**：①digest 面冷查询 = 1 次 embed RTT（~300ms-10s，集群回合分钟级不敏感；超时即降级）；②token 成本：注入块 ~1.5k tokens ×集群成员数/回合——digest 臂实测推理放大 3–5×（§15.30 注记①），预算护栏即渲染硬顶，无 LLM 调用增量；③回退阶梯保证最坏等于现状。
