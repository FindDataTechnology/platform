# Tasks: fix-digest-adaptive-embed-deadline

## 1. fd-memory：自适应预算

- [x] 1.1 `src/metrics.ts` 增加只读的近期成功样本分位读取（复用现有 `embedSamples` 滑动窗），不改 `/admin/metrics` 输出形状
- [x] 1.2 `src/http.ts` 把 `EMBED_DEADLINE_MS` 常量改为按 `p90 × 1.5` 推导并 clamp 到 `[3000, FD_MEMORY_DIGEST_EMBED_DEADLINE_MS]`；样本数 < 5 时用保守默认值
- [x] 1.3 超时分支在 reject 前记录真实 `elapsed`，样本写 `reason: "timeout"`（与 `cooling_down`、上游错误可区分）
- [x] 1.4 单测：快样本→预算收紧；慢样本→预算放宽但不超上限；无样本→默认；样本自强化不发生（p90 只吃成功样本）
- [x] 1.5 `npm test` 全绿 + `npx tsc --noEmit` 零错误
- [x] 1.6 **真机验收推翻 D1 的修正**：超时是右删失观测（「真实延迟 ≥ 当时预算」），必须为预算提供下界——双峰车道下纯 p90 会塌缩饿死慢请求。`budget = clamp(max(p90×headroom, maxTimeoutElapsed×1.2), floor, cap)`；非超时失败不提供下界（design D1'）

## 2. paas：调用方超时可配

- [x] 2.1 `server/cluster-memory.js`：5s 硬编码改为 `CELL_MEMORY_DIGEST_TIMEOUT_MS`，默认 9000
- [x] 2.2 确认 chat 面与集群面走同一个 `digestLadder`，一处改动两面生效（无第二处硬编码）
- [x] 2.3 单测：默认 9s 生效；显式配置覆盖；超时触发的降级 warn 仍只落一行

## 3. 文档与契约

- [x] 3.1 `CONTEXT.md` / `docs/memory-architecture-v2.md` 补「调用方超时 > fd-memory embed 预算上限」不变量与新 env
- [x] 3.2 `docs/registry-maintenance.md` 补 §15.79 续四：自适应死线与预算协商的上产记录

## 4. 上产与真机验收

- [x] 4.1 fd-memory 出片（`yizuo/fd-memory`）+ 走 GitOps `all-services/prod/fd-memory.yaml`（**主容器与 initContainer 两处**）
- [x] 4.2 paas 出片 + 滚版
- [x] 4.3 真机验：连发 6 次 digest，记录档位与耗时；确认快样本后预算收紧（不再每次赌 8s）
- [x] 4.4 真机验：制造一次慢 embed，确认 `failure_reasons` 出现 `timeout` 分类且耗时记录为真实值
- [x] 4.5 真机验：`CELL_MEMORY_DIGEST_TIMEOUT_MS` 生效（设小值观察降级、设默认观察恢复），chat 与集群两面一致
- [x] 4.6 探针回归：`scripts/probe-embedding-lane.mjs` 在健康态 exit 0、制造降级时 exit 1
