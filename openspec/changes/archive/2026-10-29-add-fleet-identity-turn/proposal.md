# Proposal: add-fleet-identity-turn

## Why

岗位身份行（`【集群岗位身份】fleet=…; post=…; title=…; target=…`，enable-wire-content-fleet D1，已在产）覆盖了部署/岗位两腿，但**没有回合标识**：成员回合自己不知道落在哪个回合上，向外部系统（柏讯 `wire_action_propose` 的 `source_ref`，要求部署/岗位/回合三元组）复述时只能编造或省略回合腿，审计链差最后一环。柏讯跨线需求（wire-domain-actions R1，2026-10-29）把回合腿列为台账标注字段；回合 id（`roundChildSessionId`，逐轮轮换、稳定可读）恰好在注入点同一函数内现成可得，约两行改动即可补齐。

## What Changes

- 成员回合的岗位身份行**追加回合段**：`turn=<该回合实际落地的子会话/回合 id>`（即 `roundChildSessionId(job, startedAt, seq)` 的产出，逐轮轮换；手动派发回合为其会话 id）。注入点在 `server/cron-runner.js` 身份行装配处——cron 节奏回合与 delegation 唤醒回合共用的同一 seam，两条路径天然同批覆盖。
- 主 spec 中该需求的**格式示例与实现对齐**：spec 示例写的是 `ref=<targetRef>`，实际在产格式是 `target=<targetKind>:<targetId>`。身份行只加段不改既有 key 名（`fleet=`/`post=`/`title=`/`target=` 保持逐字稳定——外部消费方按在产格式解析）。
- 边界不变：身份仍不含凭据；非成员回合（未在岗/归属歧义）仍逐字不注入。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-fleet-report-lane`：「舰队成员回合注入岗位身份」需求追加回合标识字段（部署/岗位/回合三元组补齐），并把格式示例校正为在产 key 名。

## Impact

- **代码**：`server/cron-runner.js`（身份行拼回合段，回合 id 就在同函数）、`server/fleet-reports.js`（`renderFleetIdentity` 增可选 turn 参数，非成员路径不受影响）。无新依赖。
- **测试**：`scripts/test-fleet-report-lane.mjs` 身份行断言补 turn 字段；相关 cron-runner 回合装配用例同步。
- **spec**：`agent-fleet-report-lane` 一份 delta。
- **出片**：server/ 有改动，需镜像出片。
- **兼容性**：非成员回合逐字零变化；成员回合仅追加一段，既有四字段顺序与 key 名不动，模型复述与既有解析不受扰。
- **跨线契约**：补齐后柏讯 `wire_action_propose` 的 `source_ref` 可由身份行逐字复述为完整三元组（fleet/post/turn），台账标注字段兑现。
