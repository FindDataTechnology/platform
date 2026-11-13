# add-cluster-digest-injection — Design

> 前置：add-continuation-eval 首跑 PASS（台账 §15.30）——digest 臂对无记忆臂双门全过、对标题臂更强。原型件：fd-memory `src/digest.ts`（渲染器）+ `hybridCandidates`（共享检索，add-continuation-eval 抽出的导出）。本 change 只做「把过门的原型接进现成管线」，不新增任何记忆语义。

## D1 渲染单源在 fd-memory 服务侧

paas 不复刻渲染（两套格式必然漂移——评测结论对生产失效）。`/digest` 面内部就是 `hybridCandidates`（检索）+ `renderDigest`（渲染）+ open handoffs 读取，三件全是评测验证过的同一代码。评测的 digest 臂、S3 生产注入、未来的 S5/v4 注入线共用一个实现点。

## D2 检索查询文本与作用范围

- `q` = 本回合任务 prompt 原文（`job.prompt`），由 paas 调用时携带；一次渲染、全员注入同一块（与现状 hook ① 的 readShared(5) 同构——共享记忆本来就是回合级而非成员级个性化）。
- 检索范围 = 该 cluster project 本身（`hybridCandidates` 的 `[project, "shared"]` 并集语义保留——cluster project 在 owner root 下天然单 project，shared 并集为空集，无副作用）。
- handoffs 段来源 = 该 project open 交接（upsertHandoff 的 state），渲染器预算优先级保证其不被截掉。

## D3 降级阶梯（三档，每档 warn 一行）

```
digest 面（5s 超时） ──失败──▶ /pages 标题列表（现状代码路径，10s 超时） ──失败──▶ 无块
```

- 超时值：digest 5s（一次 embed RTT + 渲染，冷查询最坏 ~10s 时超时降级——宁可回退不可拖慢回合）；/pages 沿现状。
- 降级不重试、不缓存负面结果（下一回合再试 digest 面）。
- `CELL_MEMORY_ENABLED=0`：两档读取都不发起（现有 clusterMemoryFor null 路径已保证），字节归零不变。

## D4 参数与钳制

- paas 侧默认 k=5 / budget=1500（评测所用值）；`CELL_MEMORY_DIGEST_K` / `CELL_MEMORY_DIGEST_BUDGET` env 覆盖。
- fd-memory 服务端硬顶 k≤8 / budget≤2000（与渲染器护栏一致；防止未来调用方把注入块撑爆上下文——zcode 索引腐化的教训在案）。

## D5 验收与观察

- 单测：fd-memory 权限矩阵（person/平台缝 rootKey/agent 拒）、embed 降级、参数钳制；paas 三档降级 + 开关归零（现有 cluster-memory/cron 测试扩展）。
- 真机：滚产后下一轮集群回合——成员任务 prompt 含 digest 块眼见（会话留档）；**降级演练**：临时断 `FD_MEMORY_URL` 指向（或 sidecar scale 0 一轮）看回退标题列表与 warn 行。
- 观察项（田野侧两段验证）：后续回合 digest 是否引用前轮沉淀而非重推导；交接认领率自 8% 基线的走向（台账随记）。

## D6 网格定默认（接 add-continuation-eval 5.2）

apply 期跑 k∈{3,5} × budget∈{800,1500} digest 臂 4 组（eval-continue 12 场景 × 4 参数 ≈ 60–80k tokens），以重推导度为主指标定终值，结果回填本 change 与 continue-baseline。若四组差异 <0.2 分则维持 5/1500（简单默认优先）。

## D7 风险与回滚

- 回滚杆 = paas env `CELL_MEMORY_DIGEST=0`（回标题列表现状）或 `CELL_MEMORY_ENABLED=0`（回零）；fd-memory 侧 /digest 是纯读面，无需回滚。
- 成本护栏：digest 面零 LLM 调用（检索=向量余弦+关键词）；注入块 token 上限即 budget，集群成员数 ×回合频率的注入成本可预算。
- 最坏情况 = 现状（标题列表），阶梯保证。
