# Proposal — fix-agent-discovery-honesty

## Why

`GET /api/delegation/agents` 与 `search_agents` 这对「两级发现」面**对自己的大小撒谎**
（explore P2-8 的 discovery 部分）：

```js
// server/routes/delegation.js —— 旧实现
const scored = all.map(...).filter((x) => x.hit).slice(0, 8);
res.json({ agents: scored.map((x) => x.a) });   // 没有 total，没有 truncated
```

```js
// server/delegation-mcp.js —— 旧实现
return textOut(`Online market agents (${agents.length}):\n...`);  // 把「页大小」写成「市场大小」
```

后果是两个叠加的错：

1. **静默截断**：关键词匹配 30 个，模型只看到 8 个，且被告知「Online market agents (8)」——
   它据此认为市场只有 8 个，从**任意切片**里挑目标。
2. **切片还是随机的**：`.slice(0, 8)` 作用在 catalog 的扫描顺序上，两次同样的查询可能返回
   不同的 8 个——「你能看见谁」不该是随机的。

## What Changes

- 抽出**一个定义** `server/agent-discovery.js`：
  - `searchAgentsView({ all, search, limit })` → `{ agents, total, truncated }`，
    `total` 是**匹配数**、`truncated` 是「页被截断」；顺序按名称再按 id **确定性排序**；
    `limit` 默认 8、上限 50、非法值回落默认。
  - `formatSearchAgentsText({ agents, total, truncated })` → 截断时写
    「showing 8 of 12 matches」+「收窄关键词或提高 limit」；未截断时写真实条数。
- 路由与 MCP 子进程**都改成引用这一处**——同一缺陷在两个面上不会再各自漂移。
- `search_agents` 的 inputSchema 增加可选 `limit`（1–50），描述里说明「页被截断会明说」。

## Impact

- Affected specs: `agent-delegation-a2a`（MODIFIED：Discovery is two-level —— 追加分页诚实性与 3 个场景）
- Affected code: 新增 `server/agent-discovery.js`；`server/routes/delegation.js`（改用共享视图）、
  `server/delegation-mcp.js`（改用共享文案 + limit 参数）
- 无迁移、无新表、无新依赖；默认页仍是 8，未截断时的文案与行为不变（只多了真实总数）。
- 顺带把路线图 P2-2 / P2-3 / P2-9 的陈旧条目按代码证据改正（三处早已修过，见该文 §五）。
