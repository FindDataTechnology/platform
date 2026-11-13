# Design: fix-turn-token-attribution

## Context

生产 700/700 `ok:true` 计量行 tokens:null。三处 dsh 源码证据（/opt/dsh 镜像内
@deepseek-ai 包族）：
- `dsh-llm-pi-ai/lib/index.js` 终态（done+error 双路）必发 `{type:"usage"}` chunk，
  `mapUsage` 产出 `{inputTokens, outputTokens[, cacheRead/WriteTokens]}`（camelCase 分列，
  cache 仅非零出现）；
- `dsh-agent-loop/lib/index.js` 把 `assembler.usage` 挂到 assistant/message 事件
  `data.usage`（interrupted 路径同样带）；
- `dsh-session` 注释明言 empty-content assistant/message「exists only to host usage」。

runner 采集器读位正确（`event.data.usage`）→ `lastUsage` 一直有值；凶手是
`manager.js tokensOf` 只认 OpenAI 总数命名。

## Solution

`tokensOf` 双形状：总数命名优先（既有语义零变化），harness 分列求和回退：

```js
const t = usage.total_tokens ?? usage.totalTokens ?? usage.tokens;
if (Number.isFinite(Number(t))) return Number(t);
const input = Number(usage.inputTokens ?? usage.input_tokens);
const output = Number(usage.outputTokens ?? usage.output_tokens);
if (Number.isFinite(input) && Number.isFinite(output)) return input + output;
return null;
```

cache 不计入合计（口径=input+output，与 spec「输入/输出合计」一致；cache 计费另轨，
真需要时由消费方读原样 usage）。两形状都不匹配 → null 维持（不猜）。

## Tests

- fakeHarnessClient 的 assistant/message 补 `usage: {inputTokens: 120, outputTokens: 30}`
  （镜像真实形状——假件此前从不带 usage 正是缺陷漏网原因）；
- 计量测试断言 `tokens === 150`；
- 新增纯路径变体：无 usage 事件回合 tokens 仍 null（`harness: {reply, noUsage: true}`
  或独立 clientFactory 闭包）。

## Risks / Trade-offs

- 双计数风险（总数与分列同时存在）：总数优先+短路，不会相加。
- 生产验证依赖上游恢复（当前全窗 503）：按 error-class 迁移+自然流量前例；
  dsh 源码证据链已足以钉死形状。

## Migration Plan

平台镜像三 runner 清单同滚，无配置无数据迁移；revert 镜像即回滚。
