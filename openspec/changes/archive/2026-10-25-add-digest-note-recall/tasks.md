# add-digest-note-recall — Tasks

## 1. /digest 召回扩层（fd-memory）

- [x] 1.1 `http.ts` /digest 组装：L2 候选后追加近期 notes（recentPages 过滤 type=note、前 3、新近在前）为 L1 items，同渲染器按预算截断；响应增 `notes` 计数、truncated 覆盖全层
- [x] 1.2 单测：无 L2 有 notes 时块含〔L1·note〕条目与日期 / 预算挤迫先截 notes / 被忘 note 不进块（渲染器预算纪律回归既有测兜底）

## 2. 出片与真机闭环验收

- [x] 2.1 fd-memory 单镜像出片（fd-build-channel 判路）+ GitOps 滚产 + 烟测（/digest 带 notes 字段）
- [x] 2.2 构造测试：重建 drill 集群连跑两回合——第二回合 digest 块含第一回合写回 note（L1 标注眼见），开环→闭环直接证据；跑毕清 drill 残留
- [x] 2.3 台账 §15.33 回填（开环反证 + 闭环证据 + eval 分歧在案）
