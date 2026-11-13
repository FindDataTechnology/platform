# Design: fix-empty-turn-billing

## Context

挂账②收官：空返回合（模型失败但 dsh 会话照常 idle）被采集器成功结算 → facade 照计费。
前置三片已上线：facade 错回合豁免（fd-wanxing sha-ed21d00）、部署门（sha-53ef436）、
配置门+URL 自环修复（sha-ff19181）。本片是**采集器语义面**的最后一块。

## Goals / Non-Goals

- Goals: 零输出回合按失败结算；端到端免单由既有下游语义自动达成（零 facade/网关改动）。
- Non-Goals: 不修 usage 恒 null 的 token 计量（独立观察项，不在本片）；不动 facade；
  不追补历史已计费空回合（挂账②历史账已在前片处置）。

## Real Constraints Discovered (production, 2026-10-14)

1. **usage 不能当判别式**：活 meter 700/700 ok:true 行 tokens 全 null——该 dsh 版本根本
   不上报 usage。若按「null usage → 免单」会把所有真回合全免。唯一可判别信号是
   **assistant 文本**（child.js 收集 finalText：assistant/message 文本块 + chunk 累积）。
2. **-32003 路径已实证活着**：ok:false 行（503/429 自报错误）一直在产，说明 finish-error
   chunk 路径工作正常；缺口仅是「无 chunk 的静默失败」→ idle 分支。
3. **错误码空间**：-32000..-32003（child/turn）、-32004（manager 冷启动）、-32010/-
   32011（paused/delegation）。取 **-32005** 无冲突，与 -32003 区分（自报 vs 静默）。

## Proposed Solution

child.js `session.status === "idle"` 分支：

```js
if (method === "session.status" && params?.status === "idle") {
  if (!finalText.trim()) {
    return settle(false, Object.assign(
      new Error("turn ended without any assistant output (model unavailable or refused)"),
      { code: -32005 }));
  }
  return settle(true, { text: finalText, usage: lastUsage });
}
```

trim 判定：空白-only 回合同为零交付。下游全部零改动接管：
manager catch → meter ok:false + turn_ended outcome=error；a2a catch → JSON-RPC error /
SSE event:error；facade → waived（已上线）。

## Risks / Trade-offs

- **假阳性（真实但零文本的纯工具回合）**：免单是诚实取向（无交付不收费，平台自担
  上游成本）——与错回合豁免同一既定政策（ADR-0022 负保护）。观测面可从计量行
  error 字段直接识别 -32005 行，若未来出现规模化假阳性可再细分。
- **对 message/stream 的影响**：零输出回合此前也发不出任何 delta，仅终点从
  `message:""+done` 变为 `event:error`——调用方信号更诚实，无兼容破坏（v1 文本面）。

## Migration Plan

平台镜像单滚（agent-runner-serving + runner-b/c 三清单同滚，标准 GHA 绕行线）；
runner 进程重启后按 poll 周期自然接管，无数据迁移、无配置变更、无回滚面（revert
镜像即可）。

## Open Questions

无。
