# add-write-triggered-distill — Proposal

## Why

构造基准（台账 §15.38）实测：人根蒸馏延迟 = fallback 10min 扫描周期 + 分批耗时——「这轮说的话」要等约 10 分钟才能被下轮召回。chat 场景的记忆价值随时间急速衰减（用户交代的事下一句话就要用），而 note/handoff 的 MCP 写入本来就是离散、明确的蒸馏原料事件——完全没必要等周期扫描发现。

## What Changes

fd-memory 单端：MCP 写面（`memory_write_page` 记 note、`memory_handoff_begin` 开交接）成功后即时通知调度器标记该 project 待蒸馏；u- 根用短去抖（60s，对比 d- 根既有 5min 会话边界去抖），写后约 1-2 分钟内蒸馏可用。d- 根零行为变化（仍走会话边界触发与 5min 去抖）；fallback 周期扫描照旧兜底（写通知丢失也不丢原料）。

### Modified Capabilities

- `memory-distiller`：调度需求扩入「写触发」通道与人根短去抖。

### Non-goals

- chat 回合结束（session-end）上报链路（paas ws.js 接线）——写触发已覆盖 chat 场景的核心原料（note/handoff），回合级观测（L0）蒸馏仍走 fallback。
- d- 根的任何触发语义变化。

## Impact

- **代码**：fd-memory `src/mcp.ts`（写后 notify 回调）、`src/http.ts`（接线 notify → scheduler）、`src/distill-scheduler.ts`（u- 短去抖）。paas 零改动。
- **成本**：u- 根写频低（构造基准实测个位数/日/根），60s 去抖合并连续写；蒸馏 token 预算护栏不变。
- **风险与回滚**：notify 是进程内可选回调（不传 = 现状）；开关 `FD_MEMORY_DISTILL_U=0` 继续管人根总闸。
