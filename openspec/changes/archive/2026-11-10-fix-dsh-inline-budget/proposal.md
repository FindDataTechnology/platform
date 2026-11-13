# Proposal — fix-dsh-inline-budget

## Why

`context_overflow` 是今晚剩余失败的主因（占失败 2/3），且都在 **comp=1、165–209 秒**就倒下。按事件类型量体积后定性：

| 回合 | 总量 | 最大三条 |
|---|---|---|
| A | 332KB | assistant **43KB** / tool **40KB** / user 17KB |
| B | 206KB | assistant **35KB** / developer 27KB / user 17KB |
| C | 219KB | tool **23KB** / user 17KB / assistant 14KB |

**平台注入（模板 + 渲染后的 fleetContext ≈17KB）只占 13–21%**；79–87% 是模型单步产出与工具结果。

调研 dsh 内部后找到真正的旋钮（此前误判为「上游无此能力」）：

```
/opt/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml
- id: spill-policy
  name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineTokens: 12500        # ≈40KB —— 与实测的 40KB/条 完全吻合
```

也就是说 dsh **本来就有**输出保留/溢出（spill）机制，只是内联预算被设在 40KB 量级。而**平台已经在写同一份 patch 文件**（`writeLlmProfile` 就在 upsert `llm-pi-ai` 行），所以这是平台侧可配的，改动不需要碰 dsh 源码。

## What Changes

- `writeLlmProfile` 追加一行 `spill-policy` 覆盖：`maxInlineTokens` 由 `inlineTokensBudget()` 决定，默认 **4000**（≈13KB），`DSH_MAX_INLINE_TOKENS` 可调，非法/非正值回落默认（**绝不落 0**）。
- 旧的 `spill-policy` 行被替换而非重复（与 `llm-pi-ai` 同款 upsert）。
- 超出内联预算的文本照旧 spill 落盘 + 引用——**代价是一次重读，不是信息丢失**。

## Impact

- Affected specs: `dsh-runtime-bridge`（profile 组合条款 + 2 场景）
- Affected code: `dsh-profile.js`（`inlineTokensBudget` + `writeLlmProfile`）
- 无迁移；回滚 = `DSH_MAX_INLINE_TOKENS=12500` 或改默认值。
- 既有红不受影响：`test-session-resume`(4) / `test-connector-credentials`(3) / `test-connector-binding-migration`(2) 在**基线**上同样失败（已对照确认，非本刀引入）。
