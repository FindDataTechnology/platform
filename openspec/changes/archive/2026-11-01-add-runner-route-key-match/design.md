# Design: add-runner-route-key-match

## Context（活体取证钉死的事实，2026-11-01）

- catalog id 映射：registry-bridge.js `mapAgent` → `registry-${pathToName(a.path)}`，**前缀无条件**——
  任何 registry 条目的 catalog id 都不可能等于裸 persona 键。
- chat∩a2a 同 id = **空**（84 agents 全量核过）：add-fleet-carrier D2 设计的「部署翻同 id」前提
  在生产从未成立。
- persona roster 只收 chat roster 键：全 a2a catalog id 与裸 pack persona 键均被成员创建面拒绝
  （真机 400 实证两条）。
- a2a entry 的 registry path 尾段 = 部署 agent 键（`/packs/<packId>/<agentKey>`），与 pack persona
  的 roster 键同命名空间——**匹配数据一直在，错的只是匹配字段**。

## D1 匹配键 = registry path 尾段（部署 agent 键）

`runnerEntryFor(job)` 的谓词从 `roster(a.id) === job.preset` 改为：
`agentKeyOf(a) === job.preset`，其中 `agentKeyOf` 取 entry 的 `path`（registry 快照原样携带；仅当
快照条目缺 path 时回退从 `url` 的 `/agent<path>/` 形态解析）的**最后一个非空段**，经与 job.preset
相同的 roster 键归一（小写+非字母数字→`-`）后比较。

- 备选被否①：改 registry 映射让 id 裸化——牵动全部 26 条现存条目的 id 与下游投影，破坏面无必要。
- 备选被否②：部署面加写 chat persona 别名——双写两真源，registry-bridge 已是唯一投影（ADR-0015）。

## D2 歧义 = 显式回退，不猜测

同名 agent 键跨包并存（现网 `reception` ×3）：命中 ≥2 条 → fail-open，`detail.carrierFallback =
"runner-ambiguous"`，日志 warn 列出候选 path。**不引入打包面消歧**（成员 targetId 是裸键、不携带
packId；让成员声明 packId 是更大的面，留给需求方提出）。

## D3 实现落点与不变式

- `runnerEntryFor` 单函数改造（server/cron-runner.js），签名与返回形态不变（命中 → entry 对象，
  调用侧 `personaJob = { ...job, preset: entry.id, targetType: "a2a" }` 原样——**远端任务的 preset
  仍是 entry.id**，a2a executor 按 id 取 entry，语义不变）。
- fail-open 两源不变，新增第三源 `runner-ambiguous` 走同一 `job.carrierFallback` 通道。
- 计量不变：命中 → carrier=remote（执行器标记）；回退 → carrier=cell + detail 留痕。

## D4 测试

test-fleet-carrier 扩两枚：①path 尾段匹配命中（registry 快照形态的伪 entry：带 path 的 a2a 条目
+ persona 成员裸键）→ 远端改写发生；②双包同名 → fail-open runner-ambiguous 且不命中任何一条。
既有 no-entry 用例原样保绿。
